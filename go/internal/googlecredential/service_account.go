// Package googlecredential validates the Google OAuth exchange destination
// for service-account keys written by IAM or used by a provider.
package googlecredential

import (
	"encoding/json"
	"errors"
	"strings"

	gcpauth "github.com/kayiik/llm-provider-auth/gcp"
)

// Parse accepts standard Google service accounts and the two token endpoints
// Google issues for them. An omitted token_uri uses Google's default.
func Parse(secret string) (*gcpauth.Credential, error) {
	credential, err := gcpauth.Parse([]byte(secret))
	if err != nil {
		return nil, err
	}
	// encoding/json matches a name regardless of case and keeps its last
	// match, which is also how the library chooses the exchange destination.
	var key struct {
		TokenURI string `json:"token_uri"`
	}
	if err := json.Unmarshal([]byte(secret), &key); err != nil {
		return nil, errors.New("service account key: not valid JSON")
	}
	switch strings.TrimSpace(key.TokenURI) {
	case "", "https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token":
		return credential, nil
	default:
		return nil, errors.New("service account key: token_uri is not a Google OAuth token endpoint")
	}
}
