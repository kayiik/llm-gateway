package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"llmgw/internal/config"
	"llmgw/internal/iam"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	"github.com/kayiik/llmgw-core/oauthflow"
)

func setupOAuthCompletionExpiry(t *testing.T) (iam.Principal, iam.Principal) {
	t.Helper()
	t.Setenv("LLMGW_STATE_DIR", t.TempDir())
	iam.ResetForTests()
	t.Cleanup(iam.ResetForTests)
	previous := *config.Get()
	t.Cleanup(func() { config.Update(func(settings *config.Settings) { *settings = previous }) })
	config.Update(func(settings *config.Settings) {
		settings.CredentialEncryptionKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{11}, 32))
	})
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}
	people := make([]iam.Principal, 2)
	for index, name := range []string{"a", "b"} {
		person, err := iam.CreatePrincipal("human", "fixture:expiry-owner-"+name, "", "Fixture owner "+name)
		if err != nil {
			t.Fatal(err)
		}
		people[index] = person
	}
	return people[0], people[1]
}

func completeFixtureOAuth(owner iam.Principal, method oauthflow.Method, name string, expiry time.Time) (string, *oauthCompletion, error) {
	completion := &oauthCompletion{providerRef: "github_copilot", name: name, source: iam.ConnectionSourceUser}
	ctx := withOAuthCompletion(context.Background(), completion)
	id, err := storeOAuthConnection(ctx, oauthflow.Completion{
		Caller: oauthCaller(owner), Instance: "github_copilot", Method: method,
		Params: oauthConnectionParams(name, iam.ConnectionSourceUser, "github_oauth"),
		Record: tokenstore.Record{
			AccessToken: "fixture-private-access", RefreshToken: "fixture-private-refresh",
			TokenType: "Bearer", Expiry: expiry, AccountID: "fixture-account",
		},
	})
	return id, completion, err
}

func TestOAuthCompletionExpiryPersistsPrivateOwnership(t *testing.T) {
	positive := time.Date(2030, time.January, 2, 3, 4, 5, 0, time.UTC)
	for _, method := range []oauthflow.Method{oauthflow.MethodDevice, oauthflow.MethodManual} {
		for _, expiry := range []struct {
			name string
			time time.Time
			want int64
		}{{name: "absent-or-zero"}, {name: "positive", time: positive, want: positive.Unix()}} {
			t.Run(string(method)+"/"+expiry.name, func(t *testing.T) {
				owner, other := setupOAuthCompletionExpiry(t)
				id, completion, err := completeFixtureOAuth(owner, method, "personal", expiry.time)
				if err != nil || id == "" || completion.connection == nil {
					t.Fatalf("legitimate completion was not stored: id present=%v err=%v", id != "", err)
				}
				account, found, err := iam.ProviderAccountStateByConnection(id)
				if err != nil || !found || account.ConnectionID != id || account.TokenExpiresAt != expiry.want {
					t.Fatalf("independent account expiry was not stored: found=%v expiry=%d err=%v", found, account.TokenExpiresAt, err)
				}
				if err := iam.Close(); err != nil {
					t.Fatal(err)
				}
				if _, err := iam.Initialize(); err != nil {
					t.Fatal(err)
				}
				rows, err := iam.ListProviderConnections(owner.ID, "github_copilot")
				if err != nil || len(rows) != 1 {
					t.Fatalf("reloaded connection count=%d err=%v", len(rows), err)
				}
				stored := rows[0]
				if stored.ID != id || stored.PrincipalID != owner.ID || stored.ProviderID != "github_copilot" || !stored.PrivateToPrincipal || !stored.IsDefault || stored.OAuthExpiresAt != expiry.want || stored.Status != "active" {
					t.Fatalf("ownership/default/expiry/status did not survive reload: %+v", stored)
				}
				account, found, err = iam.ProviderAccountStateByConnection(id)
				if err != nil || !found || account.ConnectionID != id || account.TokenExpiresAt != expiry.want {
					t.Fatalf("independent account expiry did not survive reload: found=%v expiry=%d err=%v", found, account.TokenExpiresAt, err)
				}
				envelope, _, found, err := iam.OAuthProviderConnectionSecret(owner.ID, "github_copilot", "personal")
				if err != nil || !found || envelope.AccessToken != "fixture-private-access" || envelope.RefreshToken != "fixture-private-refresh" || envelope.ExpiresAt != expiry.want {
					t.Fatalf("owner could not reload the encrypted envelope: found=%v err=%v", found, err)
				}
				if _, _, found, err := iam.OAuthProviderConnectionSecret(other.ID, "github_copilot", "personal"); err != nil || found {
					t.Fatalf("another human read the private connection: found=%v err=%v", found, err)
				}
				public, err := json.Marshal(stored)
				if err != nil {
					t.Fatal(err)
				}
				for _, secret := range []string{"fixture-private-access", "fixture-private-refresh"} {
					if bytes.Contains(public, []byte(secret)) {
						t.Fatal("public connection metadata exposed a synthetic token")
					}
				}
			})
		}
	}
}

func TestOAuthCompletionFailureLeavesNoPartialPrivateState(t *testing.T) {
	owner, _ := setupOAuthCompletionExpiry(t)
	expiry := time.Date(2030, time.January, 2, 3, 4, 5, 0, time.UTC)
	id, _, err := completeFixtureOAuth(owner, oauthflow.MethodDevice, "personal", expiry)
	if err != nil {
		t.Fatal(err)
	}
	db, err := iam.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER reject_fixture_connection BEFORE INSERT ON provider_connections
		WHEN NEW.connection_name = 'refused' BEGIN SELECT RAISE(ABORT, 'fixture storage refusal'); END`); err != nil {
		t.Fatal(err)
	}
	newID, completion, err := completeFixtureOAuth(owner, oauthflow.MethodDevice, "refused", expiry)
	if err == nil || newID != "" || completion.connection != nil || completion.failure != "Could not store the private OAuth connection." {
		t.Fatalf("failed persistence was presented as success: id present=%v err=%v", newID != "", err)
	}
	if strings.Contains(err.Error(), "fixture-private-") || strings.Contains(completion.failure, "fixture-private-") {
		t.Fatal("failure exposed a synthetic token")
	}
	if err := iam.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := iam.Initialize(); err != nil {
		t.Fatal(err)
	}
	rows, err := iam.ListProviderConnections(owner.ID, "github_copilot")
	if err != nil || len(rows) != 1 || rows[0].ID != id || !rows[0].IsDefault || rows[0].Status != "active" {
		t.Fatalf("failed transaction changed the existing private default: count=%d err=%v", len(rows), err)
	}
	if _, _, found, err := iam.OAuthProviderConnectionSecret(owner.ID, "github_copilot", "refused"); err != nil || found {
		t.Fatalf("failed transaction left a private envelope: found=%v err=%v", found, err)
	}
}

func TestOAuthCompletionRejectsExplicitNegativeExpiry(t *testing.T) {
	owner, _ := setupOAuthCompletionExpiry(t)
	id, completion, err := completeFixtureOAuth(owner, oauthflow.MethodDevice, "personal", time.Unix(-1, 0))
	if err == nil || id != "" || completion.connection != nil {
		t.Fatal("an explicit negative expiry bypassed the IAM contract")
	}
	rows, err := iam.ListProviderConnections(owner.ID, "github_copilot")
	if err != nil || len(rows) != 0 {
		t.Fatalf("rejected completion left private state: count=%d err=%v", len(rows), err)
	}
}
