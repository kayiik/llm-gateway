package iam

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"llmgw/internal/config"
)

// storedDatabaseHolds reports whether the stopped database's file holds
// value. Closing the database checkpoints its write-ahead log into the file.
func storedDatabaseHolds(t *testing.T, value string) bool {
	t.Helper()
	ResetForTests()
	raw, err := os.ReadFile(filepath.Join(config.StateDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Contains(raw, []byte(value))
}

func createFixtureExtension(t *testing.T, input ExtensionCreate) Extension {
	t.Helper()
	created, err := CreateExtension(input)
	if err != nil {
		t.Fatalf("create extension %q: %v", input.Name, err)
	}
	return created
}

// An extension's secret is sealed with the credential encryption key and
// bound to its extension: it is in no listing, in no file in plaintext, and
// a ciphertext copied to another extension does not open there.
func TestExtensionSecretIsStoredEncryptedAndBoundToItsExtension(t *testing.T) {
	useCredentialKeyTestState(t)
	if err := restartWithCredentialKey(fixtureCredentialKey(31)); err != nil {
		t.Fatal(err)
	}
	const secret = "fixture-extension-shared-secret"
	home := createFixtureExtension(t, ExtensionCreate{
		Name: "Home daemon", URL: "http://127.0.0.1:18888", Secret: " " + secret + " ",
	})
	if home.ID != "home-daemon" || home.Name != "Home daemon" || home.URL != "http://127.0.0.1:18888" ||
		home.CreatedAt == 0 || home.UpdatedAt != home.CreatedAt {
		t.Fatalf("created extension %+v", home)
	}
	stored, found, err := ExtensionCredentialByID(home.ID)
	if err != nil || !found || stored.Err != nil || stored.Secret != secret || stored.Extension != home {
		t.Fatalf("stored extension %+v found=%v err=%v, want it with the trimmed secret", stored.Extension, found, err)
	}
	listed, err := ListExtensions()
	if err != nil || len(listed) != 1 || listed[0] != home {
		t.Fatalf("listed %+v err=%v", listed, err)
	}
	if encoded, _ := json.Marshal(listed); bytes.Contains(encoded, []byte(secret)) {
		t.Fatal("the extension listing carries the secret")
	}
	if byID, found, err := ExtensionByID(home.ID); err != nil || !found || byID != home {
		t.Fatalf("extension by ID %+v found=%v err=%v", byID, found, err)
	}
	if storedDatabaseHolds(t, secret) {
		t.Fatal("gateway.db holds the extension's secret in plaintext")
	}

	createFixtureExtension(t, ExtensionCreate{ID: "office", Name: "Office", URL: "http://127.0.0.1:18889", Secret: "fixture-office-secret"})
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
UPDATE extensions SET
    ciphertext=(SELECT ciphertext FROM extensions WHERE id='home-daemon'),
    nonce=(SELECT nonce FROM extensions WHERE id='home-daemon')
WHERE id='office'`); err != nil {
		t.Fatal(err)
	}
	moved, found, err := ExtensionCredentialByID("office")
	if err != nil || !found || moved.Err == nil || moved.Secret != "" {
		t.Fatalf("a secret moved to another extension opened there: secret=%q found=%v err=%v", moved.Secret, found, err)
	}
	if strings.Contains(moved.Err.Error(), secret) {
		t.Fatalf("the decryption failure repeats the secret: %v", moved.Err)
	}
}

// Without the credential encryption key no secret is stored, and none is
// replaced: the store refuses rather than keep it in plaintext. What needs
// no key, such as a new name, still changes.
func TestExtensionStoreRefusesASecretWithoutTheCredentialKey(t *testing.T) {
	useCredentialKeyTestState(t)
	config.Update(func(s *config.Settings) { s.CredentialEncryptionKey = "" })
	if _, err := Initialize(); err != nil {
		t.Fatal(err)
	}
	const plaintext = "fixture-plaintext-secret"
	_, err := CreateExtension(ExtensionCreate{Name: "Home", URL: "http://127.0.0.1:18888", Secret: plaintext})
	if !errors.Is(err, ErrCredentialEncryptionNotConfigured) ||
		!strings.Contains(err.Error(), "LLMGW_CREDENTIAL_ENCRYPTION_KEY") || strings.Contains(err.Error(), plaintext) {
		t.Fatalf("create without a key: err=%v, want the refusal naming the key", err)
	}
	if listed, err := ListExtensions(); err != nil || len(listed) != 0 {
		t.Fatalf("a refused extension was stored: %+v err=%v", listed, err)
	}

	configureCredentialKey(fixtureCredentialKey(32))
	created := createFixtureExtension(t, ExtensionCreate{Name: "Home", URL: "http://127.0.0.1:18888", Secret: "fixture-sealed-secret"})
	config.Update(func(s *config.Settings) { s.CredentialEncryptionKey = "" })
	replacement := "fixture-replacement-secret"
	if _, _, err := UpdateExtension(created.ID, ExtensionUpdate{Secret: &replacement}); !errors.Is(err, ErrCredentialEncryptionNotConfigured) {
		t.Fatalf("secret replaced without a key: err=%v", err)
	}
	name := "Renamed"
	updated, changed, err := UpdateExtension(created.ID, ExtensionUpdate{Name: &name})
	if err != nil || updated.Name != name || !slices.Equal(changed, []string{"name"}) {
		t.Fatalf("rename without a key: %+v changed=%v err=%v", updated, changed, err)
	}
	unsealed, found, err := ExtensionCredentialByID(created.ID)
	if err != nil || !found || unsealed.Secret != "" || unsealed.Err == nil ||
		!strings.Contains(unsealed.Err.Error(), "LLMGW_CREDENTIAL_ENCRYPTION_KEY") {
		t.Fatalf("secret read without a key: secret=%q found=%v err=%v cause=%v", unsealed.Secret, found, err, unsealed.Err)
	}
	for _, value := range []string{plaintext, replacement, "fixture-sealed-secret"} {
		if storedDatabaseHolds(t, value) {
			t.Fatalf("gateway.db holds %q in plaintext", value)
		}
	}
}

// An extension's ID is a lowercase slug. One the administrator leaves out
// is derived from the name, and made unique; one the administrator names
// must be free.
func TestExtensionIDsAreSlugsDerivedFromTheName(t *testing.T) {
	useCredentialKeyTestState(t)
	if err := restartWithCredentialKey(fixtureCredentialKey(33)); err != nil {
		t.Fatal(err)
	}
	create := func(id, name string) (Extension, error) {
		return CreateExtension(ExtensionCreate{ID: id, Name: name, URL: "http://127.0.0.1:18888", Secret: "fixture-secret"})
	}
	longName := strings.Repeat("Very long daemon name ", 6)
	for _, test := range []struct{ name, want string }{
		{"Home Daemon", "home-daemon"},
		{"Home Daemon", "home-daemon-2"},
		{" home  daemon!! ", "home-daemon-3"},
		{"Ünïcode", "n-code"},
		{"***", "extension"},
		{longName, "very-long-daemon-name-very-long-daemon-name-very-long-daemon-na"},
		{longName, "very-long-daemon-name-very-long-daemon-name-very-long-daemon-2"},
	} {
		created, err := create("", test.name)
		if err != nil || created.ID != test.want {
			t.Fatalf("name %q: ID %q err=%v, want %q", test.name, created.ID, err, test.want)
		}
	}
	slug := regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	listed, err := ListExtensions()
	if err != nil {
		t.Fatal(err)
	}
	for _, extension := range listed {
		if !slug.MatchString(extension.ID) {
			t.Fatalf("derived ID %q is not a slug", extension.ID)
		}
	}
	if created, err := create("home_1", "Named"); err != nil || created.ID != "home_1" {
		t.Fatalf("named ID: %+v err=%v", created, err)
	}
	if _, err := create("home_1", "Again"); !errors.Is(err, ErrExtensionExists) {
		t.Fatalf("taken ID: err=%v, want ErrExtensionExists", err)
	}
	for name, input := range map[string]ExtensionCreate{
		"uppercase ID":     {ID: "Home", Name: "Home", URL: "http://127.0.0.1:18888", Secret: "s"},
		"leading dash":     {ID: "-home", Name: "Home", URL: "http://127.0.0.1:18888", Secret: "s"},
		"space in ID":      {ID: "home daemon", Name: "Home", URL: "http://127.0.0.1:18888", Secret: "s"},
		"ID too long":      {ID: strings.Repeat("a", 64), Name: "Home", URL: "http://127.0.0.1:18888", Secret: "s"},
		"no name":          {Name: "  ", URL: "http://127.0.0.1:18888", Secret: "s"},
		"name too long":    {Name: strings.Repeat("n", 201), URL: "http://127.0.0.1:18888", Secret: "s"},
		"no address":       {Name: "Home", URL: " ", Secret: "s"},
		"no secret":        {Name: "Home", URL: "http://127.0.0.1:18888"},
		"blank secret":     {Name: "Home", URL: "http://127.0.0.1:18888", Secret: "   "},
		"invalid UTF-8 ID": {ID: "h\xffome", Name: "Home", URL: "http://127.0.0.1:18888", Secret: "s"},
	} {
		var invalid *InvalidExtensionError
		if _, err := CreateExtension(input); !errors.As(err, &invalid) || invalid.Message == "" {
			t.Fatalf("%s: err=%v, want an InvalidExtensionError", name, err)
		}
	}
	if created, err := create("", strings.Repeat("é", 200)); err != nil || utf8.RuneCountInString(created.Name) != 200 {
		t.Fatalf("a name of 200 characters: %+v err=%v", created, err)
	}
}

// An update changes the fields it carries and reports which of them it
// changed; a secret it carries is always reported as replaced, never
// compared.
func TestExtensionUpdatesReportTheFieldsTheyChanged(t *testing.T) {
	useCredentialKeyTestState(t)
	if err := restartWithCredentialKey(fixtureCredentialKey(34)); err != nil {
		t.Fatal(err)
	}
	home := createFixtureExtension(t, ExtensionCreate{Name: "Home", URL: "http://127.0.0.1:18888", Secret: "fixture-first-secret"})
	text := func(value string) *string { return &value }
	for _, test := range []struct {
		update  ExtensionUpdate
		changed []string
	}{
		{ExtensionUpdate{}, []string{}},
		{ExtensionUpdate{Name: text(" Home ")}, []string{}},
		{ExtensionUpdate{URL: text("http://127.0.0.1:18889")}, []string{"url"}},
		{ExtensionUpdate{Secret: text("fixture-first-secret")}, []string{"secret"}},
		{ExtensionUpdate{Name: text("House"), URL: text("http://127.0.0.1:18890"), Secret: text(" fixture-second-secret ")}, []string{"name", "url", "secret"}},
	} {
		updated, changed, err := UpdateExtension(home.ID, test.update)
		if err != nil || !slices.Equal(changed, test.changed) || updated.ID != home.ID || updated.CreatedAt != home.CreatedAt ||
			updated.UpdatedAt < home.UpdatedAt {
			t.Fatalf("update %+v: %+v changed=%v err=%v, want changed %v", test.update, updated, changed, err, test.changed)
		}
	}
	stored, found, err := ExtensionCredentialByID(home.ID)
	if err != nil || !found || stored.Name != "House" || stored.URL != "http://127.0.0.1:18890" || stored.Secret != "fixture-second-secret" {
		t.Fatalf("after the updates: %+v secret=%q found=%v err=%v", stored.Extension, stored.Secret, found, err)
	}
	if _, _, err := UpdateExtension("missing", ExtensionUpdate{Name: text("Missing")}); !errors.Is(err, ErrExtensionNotFound) {
		t.Fatalf("update of an unknown extension: err=%v", err)
	}
	for name, update := range map[string]ExtensionUpdate{
		"blank name": {Name: text(" ")}, "blank address": {URL: text("")}, "blank secret": {Secret: text("  ")},
	} {
		var invalid *InvalidExtensionError
		if _, _, err := UpdateExtension(home.ID, update); !errors.As(err, &invalid) {
			t.Fatalf("%s: err=%v, want an InvalidExtensionError", name, err)
		}
	}
}

func TestDeleteExtensionRemovesItAndItsSecret(t *testing.T) {
	useCredentialKeyTestState(t)
	if err := restartWithCredentialKey(fixtureCredentialKey(35)); err != nil {
		t.Fatal(err)
	}
	home := createFixtureExtension(t, ExtensionCreate{Name: "Home", URL: "http://127.0.0.1:18888", Secret: "fixture-secret"})
	if deleted, err := DeleteExtension(home.ID); err != nil || !deleted {
		t.Fatalf("delete: deleted=%v err=%v", deleted, err)
	}
	if _, found, err := ExtensionCredentialByID(home.ID); err != nil || found {
		t.Fatalf("deleted extension found=%v err=%v", found, err)
	}
	if deleted, err := DeleteExtension(home.ID); err != nil || deleted {
		t.Fatalf("second delete: deleted=%v err=%v", deleted, err)
	}
}

// A secret the configured key does not open is reported on its extension,
// and the others are still read.
func TestExtensionCredentialsReportASecretTheKeyDoesNotOpen(t *testing.T) {
	useCredentialKeyTestState(t)
	key := fixtureCredentialKey(36)
	if err := restartWithCredentialKey(key); err != nil {
		t.Fatal(err)
	}
	createFixtureExtension(t, ExtensionCreate{ID: "home", Name: "Home", URL: "http://127.0.0.1:18888", Secret: "fixture-home-secret"})
	createFixtureExtension(t, ExtensionCreate{ID: "office", Name: "Office", URL: "http://127.0.0.1:18889", Secret: "fixture-office-secret"})
	ciphertext, nonce, err := encryptCredential(fixtureCredentialKey(37), []byte("fixture-foreign-secret"), extensionAAD("office"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE extensions SET ciphertext=?,nonce=? WHERE id='office'", ciphertext, nonce); err != nil {
		t.Fatal(err)
	}
	credentials, err := ExtensionCredentials()
	if err != nil || len(credentials) != 2 {
		t.Fatalf("credentials=%d err=%v", len(credentials), err)
	}
	home, office := credentials[0], credentials[1]
	if home.ID != "home" || home.Secret != "fixture-home-secret" || home.Err != nil {
		t.Fatalf("home: %+v secret=%q err=%v", home.Extension, home.Secret, home.Err)
	}
	if office.ID != "office" || office.Secret != "" || office.Err == nil || strings.Contains(office.Err.Error(), "fixture-foreign-secret") {
		t.Fatalf("office: %+v secret=%q err=%v", office.Extension, office.Secret, office.Err)
	}
}

// The start's key check reads every extension's secret: a database whose
// only encrypted value is one is not recorded as encrypted with a key that
// does not open it, and once recorded refuses that key.
func TestTheCredentialKeyCheckCoversExtensionSecrets(t *testing.T) {
	useCredentialKeyTestState(t)
	original, other := fixtureCredentialKey(38), fixtureCredentialKey(39)
	if err := restartWithCredentialKey(original); err != nil {
		t.Fatal(err)
	}
	createFixtureExtension(t, ExtensionCreate{Name: "Home", URL: "http://127.0.0.1:18888", Secret: "fixture-secret"})
	db, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM control_metadata WHERE key=?", credentialKeyCheckName); err != nil {
		t.Fatal(err)
	}
	if err := restartWithCredentialKey(other); err != nil {
		t.Fatalf("start of an unchecked database with a key that opens nothing: %v", err)
	}
	if state := credentialKeyState(t); state != CredentialKeyNotRecorded {
		t.Fatalf("a key that opens no extension secret was recorded: state %q", state)
	}
	if err := restartWithCredentialKey(original); err != nil {
		t.Fatal(err)
	}
	if err := restartWithCredentialKey(other); !errors.Is(err, ErrCredentialKeyMismatch) {
		t.Fatalf("start with another key after recording: err=%v, want the key mismatch", err)
	}
}
