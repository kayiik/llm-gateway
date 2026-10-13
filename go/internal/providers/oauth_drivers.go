package providers

import (
	"context"
	"fmt"
	"strings"

	"llmgw/internal/config"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	"github.com/kayiik/llmgw-core/extension"
	"github.com/kayiik/llmgw-core/oauthflow"
)

// Metadata keys of the records the OAuth drivers return, for what a sign-in
// reports beyond tokenstore.Record's fields. They are the keys under which
// iam's credential store carries the same envelope fields.
const (
	OAuthMetadataAccountLabel = "account_label"
	OAuthMetadataProjectID    = "project_id"
	OAuthMetadataProfile      = "oauth_profile"
	OAuthMetadataClientID     = "oauth_client_id"
)

// Start parameters that carry a flow's OAuth client to its driver: a manual
// flow's whole client, and the client ID a Codex sign-in names.
const (
	oauthParamClientID     = "client_id"
	oauthParamClientSecret = "client_secret"
	oauthParamClientMode   = "client_mode"
	oauthParamRedirectURI  = "redirect_uri"
)

// WithOAuthClientID returns params naming clientID as the OAuth client the
// flow signs in with. An empty clientID names none, rather than an empty one,
// so the companion daemon signs in with its own client.
func WithOAuthClientID(params map[string]string, clientID string) map[string]string {
	if clientID = strings.TrimSpace(clientID); clientID != "" {
		params[oauthParamClientID] = clientID
	} else {
		delete(params, oauthParamClientID)
	}
	return params
}

type ProviderAuthManualConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	ClientMode   string `json:"client_mode"`
	RedirectURI  string `json:"redirect_uri"`
}

// OAuthParams returns config as the start parameters of a manual flow,
// which its driver reads its OAuth client from.
func (config ProviderAuthManualConfig) OAuthParams() map[string]string {
	return map[string]string{
		oauthParamClientID: config.ClientID, oauthParamClientSecret: config.ClientSecret,
		oauthParamClientMode: config.ClientMode, oauthParamRedirectURI: config.RedirectURI,
	}
}

// OAuthManualConfig reads the OAuth client a manual flow started with back
// from its start parameters.
func OAuthManualConfig(params map[string]string) ProviderAuthManualConfig {
	return ProviderAuthManualConfig{
		ClientID: params[oauthParamClientID], ClientSecret: params[oauthParamClientSecret],
		ClientMode: params[oauthParamClientMode], RedirectURI: params[oauthParamRedirectURI],
	}
}

// OAuthDriver returns the driver that runs method for providerID, an
// instance whose registry auth adapter is adapterID. These are the flows the
// console offers: device authorization for Copilot and Codex, the Codex CLI's
// browser sign-in, whose loopback redirect the owner pastes back, and
// Antigravity's gateway callback and consumer_manual profile. The companion
// daemon runs each of them, through the extension a step finds when it runs
// (see extensionSignIn).
func (rt *Runtime) OAuthDriver(adapterID, providerID string, method oauthflow.Method) (oauthflow.Driver, error) {
	if isExtensionType(adapterID) {
		return extensionSignIn{runtime: rt, provider: adapterID, instance: providerID}, nil
	}
	return nil, fmt.Errorf("provider %q does not offer %s authorization", providerID, method)
}

// oauthParamExtension is the start parameter that names the extension a
// sign-in runs through.
const oauthParamExtension = "extension"

// WithSignInExtension returns params naming extensionID as the extension a
// sign-in runs through from its start to its completion, whatever serves its
// instance meanwhile, as when the sign-in configures the instance. An empty
// extensionID names none.
func WithSignInExtension(params map[string]string, extensionID string) map[string]string {
	if extensionID = strings.TrimSpace(extensionID); extensionID != "" {
		params[oauthParamExtension] = extensionID
	} else {
		delete(params, oauthParamExtension)
	}
	return params
}

// SignInExtension returns the extension WithSignInExtension named in a
// sign-in's parameters, or "".
func SignInExtension(params map[string]string) string {
	return strings.TrimSpace(params[oauthParamExtension])
}

// extensionSignIn runs a daemon provider's sign-in. A flow outlives the
// settings it started under, and its first step may come before its
// instance is configured, so each step finds its extension when it runs:
// the one the flow's parameters name, or else the one that serves the
// instance. A step that finds none fails with the configuration error that
// says why, before anything reaches a daemon.
type extensionSignIn struct {
	runtime  *Runtime
	provider string
	instance string
}

var (
	_ oauthflow.DeviceDriver = extensionSignIn{}
	_ oauthflow.CodeDriver   = extensionSignIn{}
)

// driver returns the daemon's driver for a step of a flow with params.
func (s extensionSignIn) driver(params map[string]string) (*extension.OAuthDriver, error) {
	settings, _ := s.runtime.settings.Snapshot()
	ext, err := s.extensionOf(settings, params)
	if err != nil {
		return nil, err
	}
	client, err := s.runtime.extensionClient(settings, ext)
	if err != nil {
		return nil, err
	}
	return client.OAuthDriver(s.provider), nil
}

// extensionOf returns the extension a step of a flow with params runs
// through under settings.
func (s extensionSignIn) extensionOf(settings *config.Settings, params map[string]string) (config.Extension, error) {
	named := SignInExtension(params)
	if named == "" {
		return ExtensionFor(settings, s.instance)
	}
	ext, ok := settings.Extensions[named]
	if !ok {
		return config.Extension{}, &ConfigError{Msg: fmt.Sprintf(
			"the sign-in runs through extension '%s', which is no longer configured; start it again", named)}
	}
	ext.ID = named
	return ext, nil
}

// Start implements oauthflow.Driver.
func (s extensionSignIn) Start(ctx context.Context, request oauthflow.StartRequest) (oauthflow.Authorization, error) {
	driver, err := s.driver(request.Params)
	if err != nil {
		return oauthflow.Authorization{}, err
	}
	return driver.Start(ctx, request)
}

// Poll implements oauthflow.DeviceDriver.
func (s extensionSignIn) Poll(ctx context.Context, flow oauthflow.Flow) (oauthflow.PollResult, error) {
	driver, err := s.driver(flow.Secrets.Params)
	if err != nil {
		return oauthflow.PollResult{}, err
	}
	return driver.Poll(ctx, flow)
}

// Exchange implements oauthflow.CodeDriver.
func (s extensionSignIn) Exchange(ctx context.Context, flow oauthflow.Flow, code string) (tokenstore.Record, error) {
	driver, err := s.driver(flow.Secrets.Params)
	if err != nil {
		return tokenstore.Record{}, err
	}
	return driver.Exchange(ctx, flow, code)
}
