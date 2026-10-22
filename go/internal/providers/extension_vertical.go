package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"llmgw/internal/config"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/extension"
)

// Legacy configuration aliases. New extension bindings use the provider ID
// discovered from the named extension, without a gateway type registration.
const (
	ExtensionTypeCopilot        = "github_copilot"
	ExtensionTypeCodex          = "openai_codex"
	ExtensionTypeAntigravity    = "google_antigravity"
	ExtensionTypeEdgeTTS        = "edge_tts"
	ExtensionTypeZenAnonymous   = "opencode_zen_anonymous"
	ExtensionTypeAnthropicSetup = "anthropic_setup_token"
)

// extensionSurfaces are the surfaces the daemon serves for providerType, the
// only ones the extension client sends it; the facade serves natively what
// they list beyond Chat. Copilot and anonymous OpenCode Zen serve Responses
// only for some models, which the daemon chooses in a way the gateway cannot
// see, so they list Chat alone, over which the router serves Responses. The
// daemon refuses images for Antigravity, which lists Chat alone too.
func extensionSurfaces(providerType string) []core.ModelSurface {
	switch providerType {
	case ExtensionTypeCodex:
		return []core.ModelSurface{core.ModelSurfaceChatCompletions, core.ModelSurfaceResponses}
	case ExtensionTypeCopilot, ExtensionTypeAntigravity, ExtensionTypeZenAnonymous:
		return []core.ModelSurface{core.ModelSurfaceChatCompletions}
	case ExtensionTypeEdgeTTS:
		return []core.ModelSurface{core.ModelSurfaceAudioSpeech}
	case ExtensionTypeAnthropicSetup:
		return []core.ModelSurface{core.ModelSurfaceMessages}
	}
	return nil
}

func isExtensionType(ptype string) bool {
	switch strings.ToLower(strings.TrimSpace(ptype)) {
	case ExtensionTypeCopilot, ExtensionTypeCodex, ExtensionTypeAntigravity,
		ExtensionTypeEdgeTTS, ExtensionTypeZenAnonymous, ExtensionTypeAnthropicSetup:
		return true
	default:
		return false
	}
}

// retiredExtensionType is the type that once configured a provider as "the
// companion daemon" without naming a provider the daemon serves. The
// gateway refuses it in words that say what to configure instead, rather
// than as an unknown type.
const retiredExtensionType = "extension"

func retiredExtensionTypeError(providerID string) error {
	return &ConfigError{Msg: fmt.Sprintf(
		"provider '%s': type 'extension' names no provider; set type to a provider ID advertised by the extension and name that extension in the provider's settings",
		providerID)}
}

// CompanionDaemonProviders returns, sorted, the IDs of the providers
// settings configures that the companion daemon serves: those of its types,
// and Codex by its registry entry, as the provider factory chooses them.
func CompanionDaemonProviders(settings *config.Settings) []string {
	if settings == nil {
		return nil
	}
	var served []string
	for id, cfg := range settings.Providers {
		if CompanionDaemonType(cfg) != "" {
			served = append(served, id)
		}
	}
	slices.Sort(served)
	return served
}

// CompanionDaemonType returns the provider type the companion daemon serves
// cfg as, or "" for a provider it does not serve: a type of its own, or Codex
// by its registry entry, as the provider factory chooses them.
func CompanionDaemonType(cfg *config.ProviderConfig) string {
	if cfg == nil {
		return ""
	}
	if strings.EqualFold(strings.TrimSpace(cfg.RegistryID), ExtensionTypeCodex) {
		return ExtensionTypeCodex
	}
	if strings.TrimSpace(cfg.Extension) != "" {
		return strings.TrimSpace(cfg.Type)
	}
	if providerType := strings.ToLower(strings.TrimSpace(cfg.Type)); isExtensionType(providerType) {
		return providerType
	}
	return ""
}

// ExtensionFor returns the extension that serves providerID, a provider of a
// type the companion daemon serves, under settings: the extension its
// configuration names, or else the only one settings has. Any other case is
// a configuration error naming the provider, which an administrator fixes by
// adding an extension or choosing one. A provider not configured yet, such
// as one a first sign-in configures, resolves as one that names none.
func ExtensionFor(settings *config.Settings, providerID string) (config.Extension, error) {
	var extensions map[string]config.Extension
	named := ""
	if settings != nil {
		extensions = settings.Extensions
		if cfg := settings.Providers[providerID]; cfg != nil {
			named = strings.TrimSpace(cfg.Extension)
		}
	}
	if named != "" {
		ext, ok := extensions[named]
		if !ok {
			return config.Extension{}, &ConfigError{Msg: fmt.Sprintf(
				"provider '%s': extension '%s' is not configured; add it under Providers -> Extensions or name another extension for the provider",
				providerID, named)}
		}
		ext.ID = named
		return ext, nil
	}
	switch len(extensions) {
	case 0:
		return config.Extension{}, &ConfigError{Msg: fmt.Sprintf(
			"provider '%s': no extension is configured; add the companion daemon that serves it under Providers -> Extensions",
			providerID)}
	case 1:
		for id, ext := range extensions {
			ext.ID = id
			return ext, nil
		}
	}
	return config.Extension{}, &ConfigError{Msg: fmt.Sprintf(
		"provider '%s': %d extensions are configured; choose which extension serves it", providerID, len(extensions))}
}

// ExtensionAddress returns raw as the address of an extension, trimmed and
// without a trailing slash, or the error that keeps the extension client
// from using it: the client's own check, so an address the gateway stores
// is one it can reach. The error never repeats raw, which may carry
// credentials.
func ExtensionAddress(raw string) (string, error) {
	address := strings.TrimRight(strings.TrimSpace(raw), "/")
	// The client is built only to check the address; one of its own
	// would set up a connection pool for nothing.
	if _, err := extension.NewClient(extension.Config{BaseURL: address, HTTPClient: http.DefaultClient}); err != nil {
		return "", errors.New("the url must be an absolute http or https URL without credentials, query or fragment")
	}
	return address, nil
}

// extensionClients holds the client of each extension, by ID. A client owns
// its connection pool, so the requests to one extension share its client,
// which is replaced when the extension's address or secret changes.
type extensionClients struct {
	mu      sync.Mutex
	clients map[string]*sharedExtensionClient
}

// sharedExtensionClient is the client of an extension at one address with
// one secret, and the HTTP client it sends through, whose idle connections
// are closed once it is replaced.
type sharedExtensionClient struct {
	url, secret string
	http        *http.Client
	client      *extension.Client
	infoMu      sync.Mutex
	info        extension.InfoResponse
	infoUntil   time.Time
}

// newExtensionHTTPClient returns an HTTP client like the one llmgw-core's
// extension client builds for itself: the default transport's settings and
// no redirect followed. Built here it stays within reach, so the idle
// connections of a replaced client can be closed. It sets no bound on how
// long an answer takes to begin, as llmgw-core's does for an operation
// without a timeout: every invoke and stream the gateway sends carries one
// (see extensionTimeout), and every other operation is bounded by
// llmgw-core's control timeout.
func newExtensionHTTPClient() *http.Client {
	transport := &http.Transport{}
	if shared, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = shared.Clone()
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// extensionClient returns the client of ext, one of the extensions settings
// has. A client built for another address or secret of the extension is
// replaced, and so is the client of an extension settings no longer has;
// their idle connections are closed, since no request reaches them again.
// An extension the gateway cannot use, or an address the client cannot use,
// is a configuration error, which permits failover without marking the
// provider unhealthy; it names the extension but not its address, which may
// carry credentials.
func (rt *Runtime) extensionClient(settings *config.Settings, ext config.Extension) (*extension.Client, error) {
	shared, err := rt.extensionConnection(settings, ext)
	if err != nil {
		return nil, err
	}
	return shared.client, nil
}

func (rt *Runtime) extensionConnection(settings *config.Settings, ext config.Extension) (*sharedExtensionClient, error) {
	if ext.Unusable != "" {
		return nil, &ConfigError{Msg: fmt.Sprintf("extension '%s' cannot be used: %s", ext.ID, ext.Unusable)}
	}
	cache := &rt.extensions
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if settings != nil {
		for id, gone := range cache.clients {
			if _, kept := settings.Extensions[id]; !kept {
				gone.http.CloseIdleConnections()
				delete(cache.clients, id)
			}
		}
	}
	current := cache.clients[ext.ID]
	if current != nil && current.url == ext.URL && current.secret == ext.Secret {
		return current, nil
	}
	httpClient := newExtensionHTTPClient()
	client, err := extension.NewClient(extension.Config{BaseURL: ext.URL, Secret: ext.Secret, HTTPClient: httpClient})
	if err != nil {
		// A failed rebuild leaves the last client in place, for the
		// extension's previous address.
		return nil, &ConfigError{Msg: fmt.Sprintf(
			"extension '%s' has an address the gateway cannot use: it must be an absolute http or https URL without credentials, query or fragment",
			ext.ID)}
	}
	if current != nil {
		current.http.CloseIdleConnections()
	}
	if cache.clients == nil {
		cache.clients = map[string]*sharedExtensionClient{}
	}
	current = &sharedExtensionClient{url: ext.URL, secret: ext.Secret, http: httpClient, client: client}
	cache.clients[ext.ID] = current
	return current, nil
}

// extensionClientFor returns the client of the extension that serves
// instance under settings.
func (rt *Runtime) extensionClientFor(settings *config.Settings, instance string) (*extension.Client, error) {
	ext, err := ExtensionFor(settings, instance)
	if err != nil {
		return nil, err
	}
	return rt.extensionClient(settings, ext)
}

// instanceExtensionClient is extensionClientFor under the published
// settings, for what the facade asks the daemon outside the core Runtime:
// its catalog and its speech.
func (rt *Runtime) instanceExtensionClient(instance string) (*extension.Client, error) {
	settings, _ := rt.settings.Snapshot()
	return rt.extensionClientFor(settings, instance)
}

// extensionCoreVertical returns the coreVertical of providerType, which the
// companion daemon serves. The Runtime builds its verticals when it is
// created, before any extension is known, so the client of the extension
// that serves an instance is looked up when its provider is built or its
// credential refreshed, under the settings of that build. The core Runtime
// keeps both until the settings' generation changes, which every change of
// an extension or of a provider's binding publishes, so none outlives the
// address and secret it was built for.
func (rt *Runtime) extensionCoreVertical(providerType string) coreVertical {
	if providerType == extensionCoreType {
		return rt.discoveredExtensionVertical()
	}
	isOAuth := providerType == ExtensionTypeCodex || providerType == ExtensionTypeCopilot || providerType == ExtensionTypeAntigravity
	return coreVertical{
		serves: func(_ *config.Settings, _ string, cfg *config.ProviderConfig) bool {
			if cfg == nil {
				return false
			}
			t := strings.ToLower(strings.TrimSpace(cfg.Type))
			r := strings.ToLower(strings.TrimSpace(cfg.RegistryID))
			if providerType == ExtensionTypeCodex {
				return t == ExtensionTypeCodex || r == ExtensionTypeCodex
			}
			return t == providerType
		},
		provider: func(settings *config.Settings, instance string) (core.Provider, error) {
			client, err := rt.extensionClientFor(settings, instance)
			if err != nil {
				return nil, err
			}
			info := extension.ProviderInfo{ID: providerType, Surfaces: extensionSurfaces(providerType)}
			return &extensionPreparedProvider{Provider: extension.NewProvider(client, info), client: client, info: info, runtime: rt, instance: instance}, nil
		},
		refresh: func(settings *config.Settings, instance string) tokenstore.RefreshFunc {
			return func(ctx context.Context, current tokenstore.Record) (tokenstore.Record, error) {
				client, err := rt.extensionClientFor(settings, instance)
				if err != nil {
					return tokenstore.Record{}, err
				}
				return client.Refresh(ctx, providerType, current)
			}
		},
		credentials: extensionCredentials{
			open: func() (core.CredentialStore, error) { return rt.openCredentials(isOAuth) },
		},
	}
}

// Bind model evidence at the operation boundary: the provider factory is shared,
// while catalogs belong to the calling identity and configured instance.
type extensionPreparedProvider struct {
	*extension.Provider
	client   *extension.Client
	info     extension.ProviderInfo
	runtime  *Runtime
	instance string
}

func (p *extensionPreparedProvider) PrepareCall(ctx context.Context, request core.Request, options core.CallPreparationOptions) (core.PreparedCall, error) {
	caller := coreOperationFrom(ctx).caller
	provider := extension.NewProviderWithModelLookup(p.client, p.info, func(model string) (core.ModelInfo, bool) {
		row, found := p.runtime.CatalogCachedLookupForPrincipal(p.instance, model, caller)
		return CoreModelInfo(row), found
	})
	return provider.PrepareCall(ctx, request, options)
}

type extensionCredentials struct {
	open    func() (core.CredentialStore, error)
	resolve func(context.Context, core.Caller, string) (string, error)
}

func (c extensionCredentials) Resolve(ctx context.Context, caller core.Caller, instance string) (string, error) {
	if c.resolve != nil {
		return c.resolve(ctx, caller, instance)
	}
	store, err := c.open()
	if err != nil {
		return "", err
	}
	return store.Resolve(ctx, caller, instance)
}

func (c extensionCredentials) Load(ctx context.Context, key string) (tokenstore.Record, error) {
	store, err := c.open()
	if err != nil {
		return tokenstore.Record{}, err
	}
	return store.Load(ctx, key)
}

func (c extensionCredentials) Save(ctx context.Context, key string, record tokenstore.Record) (tokenstore.Record, error) {
	store, err := c.open()
	if err != nil {
		return tokenstore.Record{}, err
	}
	return store.Save(ctx, key, record)
}

func (c extensionCredentials) ReplaceIfCurrent(ctx context.Context, key, revision string, record tokenstore.Record) (tokenstore.Record, error) {
	store, err := c.open()
	if err != nil {
		return tokenstore.Record{}, err
	}
	return store.ReplaceIfCurrent(ctx, key, revision, record)
}

func (c extensionCredentials) RevokeIfCurrent(ctx context.Context, key, revision string) error {
	store, err := c.open()
	if err != nil {
		return err
	}
	return store.RevokeIfCurrent(ctx, key, revision)
}

func (c extensionCredentials) Lease(ctx context.Context, key string) (func(), error) {
	store, err := c.open()
	if err != nil {
		return nil, err
	}
	return store.Lease(ctx, key)
}

// ExtensionProviderFacade wraps an extension-served provider for the gateway's router.
type ExtensionProviderFacade struct {
	runtime    *Runtime
	instance   string
	providerID string
	caller     core.Caller
	// timeout is how long the daemon waits for the provider's answer to
	// begin, and then between two reads of it; see extensionTimeout.
	timeout time.Duration
}

// defaultExtensionTimeoutSeconds is the timeout of a provider the companion
// daemon serves that sets none.
const defaultExtensionTimeoutSeconds = 300.0

// extensionTimeout is the timeout of instance cfg, which the daemon serves as
// a provider of providerType: its own, or a GitHub Copilot provider's
// setting, or the default. Every invoke and stream carries it, so the daemon
// waits for the provider as long as other provider types wait for theirs,
// and the client sets no bound of its own: without it, an invoke is cut
// after the client's default however long the provider keeps answering.
func extensionTimeout(settings *config.Settings, providerType string, cfg *config.ProviderConfig) time.Duration {
	seconds := cfg.TimeoutOr(0)
	if seconds <= 0 && providerType == ExtensionTypeCopilot && settings != nil {
		seconds = settings.GithubCopilotTimeoutSeconds
	}
	if !(seconds > 0) {
		seconds = defaultExtensionTimeoutSeconds
	}
	if seconds >= float64(math.MaxInt64)/float64(time.Second) {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(seconds * float64(time.Second))
}

// newExtensionFacade returns the facade of instance, which the daemon serves
// as a provider of type providerID with timeout. A provider the daemon serves
// over Messages gets the facade that answers Messages natively.
func (rt *Runtime) newExtensionFacade(instance, providerID string, caller core.Caller, timeout time.Duration) Provider {
	facade := &ExtensionProviderFacade{
		runtime:    rt,
		instance:   instance,
		providerID: providerID,
		caller:     caller,
		timeout:    timeout,
	}
	if facade.serves(core.ModelSurfaceMessages) {
		return &extensionMessagesFacade{extensionChat: facade, facade: facade}
	}
	return facade
}

func (f *ExtensionProviderFacade) IsStub() bool {
	return false
}

// daemonField reports whether a request field goes to the daemon. A field
// prefixed "_" is one of the gateway's own controls, such as the failover
// budget, the affinity key or the adaptation switch: it is not part of the
// client's request, and the daemon does not read it, so it stays here. The
// daemon reads two: a Chat body's _max_output_tokens, the output limit a
// Responses request carries through the Chat fallback, which it turns into
// the provider's own limit where the provider has one, and a Messages body's
// _llmgw_preamble, the gateway's preamble, which it puts before the system
// prompt.
func daemonField(key string) bool {
	switch key {
	case "_max_output_tokens", "_llmgw_preamble":
		return true
	}
	return !strings.HasPrefix(key, "_")
}

func (f *ExtensionProviderFacade) Complete(model string, messages []Message, kw Kwargs) (map[string]any, error) {
	resp, _, err := f.CompleteContextWithObservation(context.Background(), model, messages, kw)
	return resp, err
}

func (f *ExtensionProviderFacade) CompleteWithObservation(model string, messages []Message, kw Kwargs) (map[string]any, *CredentialObservation, error) {
	return f.CompleteContextWithObservation(context.Background(), model, messages, kw)
}

func (f *ExtensionProviderFacade) CompleteContextWithObservation(ctx context.Context, model string, messages []Message, kw Kwargs) (map[string]any, *CredentialObservation, error) {
	return f.answer(f.invoke(ctx, core.ModelSurfaceChatCompletions, model, chatPayload(model, messages, kw, false)))
}

func (f *ExtensionProviderFacade) Stream(model string, messages []Message, kw Kwargs) (StreamIter, error) {
	return f.StreamContext(context.Background(), model, messages, kw)
}

func (f *ExtensionProviderFacade) StreamContext(ctx context.Context, model string, messages []Message, kw Kwargs) (StreamIter, error) {
	return f.stream(ctx, core.ModelSurfaceChatCompletions, model, chatPayload(model, messages, kw, true))
}

func (f *ExtensionProviderFacade) CompleteResponses(model string, payload map[string]any) (map[string]any, *CredentialObservation, error) {
	return f.CompleteResponsesContext(context.Background(), model, payload)
}

// CompleteResponsesContext sends Responses as they are to a provider whose
// daemon serves them, which keeps what the Chat fallback cannot carry, such
// as encrypted reasoning. Any other provider refuses with
// ErrResponsesUnsupported before anything is sent, on which the router
// serves the request over Chat.
func (f *ExtensionProviderFacade) CompleteResponsesContext(ctx context.Context, model string, payload map[string]any) (map[string]any, *CredentialObservation, error) {
	if !f.serves(core.ModelSurfaceResponses) {
		return nil, nil, ErrResponsesUnsupported
	}
	return f.answer(f.invoke(ctx, core.ModelSurfaceResponses, model, payload))
}

func (f *ExtensionProviderFacade) StreamResponses(model string, payload map[string]any) (StreamIter, *CredentialObservation, error) {
	return f.StreamResponsesContext(context.Background(), model, payload)
}

func (f *ExtensionProviderFacade) StreamResponsesContext(ctx context.Context, model string, payload map[string]any) (StreamIter, *CredentialObservation, error) {
	if !f.serves(core.ModelSurfaceResponses) {
		return nil, nil, ErrResponsesUnsupported
	}
	stream, err := f.stream(ctx, core.ModelSurfaceResponses, model, payload)
	return stream, nil, err
}

// serves reports whether the daemon serves surface for the facade's provider.
func (f *ExtensionProviderFacade) serves(surface core.ModelSurface) bool {
	if f.runtime != nil && f.runtime.settings != nil {
		settings, _ := f.runtime.settings.Snapshot()
		if cfg := settings.Providers[f.instance]; cfg != nil && strings.TrimSpace(cfg.Extension) != "" {
			info, err := f.runtime.extensionProviderInfo(context.Background(), settings, f.instance)
			return err == nil && slices.Contains(info.Surfaces, surface)
		}
	}
	return slices.Contains(extensionSurfaces(f.providerID), surface)
}

func (f *ExtensionProviderFacade) credentialVertical() string {
	if f.runtime == nil || f.runtime.settings == nil {
		return f.providerID
	}
	settings, _ := f.runtime.settings.Snapshot()
	if cfg := settings.Providers[f.instance]; cfg != nil && strings.TrimSpace(cfg.Extension) != "" {
		return extensionCoreType
	}
	return f.providerID
}

// chatPayload is the Chat body of messages and kw.
func chatPayload(model string, messages []Message, kw Kwargs, stream bool) map[string]any {
	payload := map[string]any{"model": model, "messages": messages}
	if stream {
		payload["stream"] = true
	}
	for k, v := range kw {
		payload[k] = v
	}
	return payload
}

// request is the core request of payload on surface, without the fields that
// stay in the gateway.
func (f *ExtensionProviderFacade) request(surface core.ModelSurface, model string, payload map[string]any) (core.Request, error) {
	body := make(map[string]any, len(payload))
	for key, value := range payload {
		if daemonField(key) {
			body[key] = value
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return core.Request{}, fmt.Errorf("marshal request: %w", err)
	}
	return core.Request{Surface: surface, Model: model, Body: raw, ContentType: core.ContentTypeJSON}, nil
}

// invoke performs one non-streaming operation of payload on surface.
func (f *ExtensionProviderFacade) invoke(ctx context.Context, surface core.ModelSurface, model string, payload map[string]any) (core.Response, *CredentialObservation, error) {
	request, err := f.request(surface, model, payload)
	if err != nil {
		return core.Response{}, nil, err
	}
	ctx, collector := collectCredentials(extension.WithTimeout(ctx, f.timeout))
	response, err := f.runtime.core.Invoke(ctx, f.caller, f.instance, request)
	if err != nil {
		return core.Response{}, collector.Observation(), extensionFailure(ctx, f.instance, err)
	}
	return response, collector.Observation(), nil
}

// answer decodes what invoke returned. An answer the gateway cannot read
// counts against the circuit, as an upstream's does, but is not repeated.
func (f *ExtensionProviderFacade) answer(response core.Response, observation *CredentialObservation, err error) (map[string]any, *CredentialObservation, error) {
	if err != nil {
		return nil, observation, err
	}
	var result map[string]any
	if json.Unmarshal(response.Body, &result) != nil {
		return nil, observation, f.unreadable()
	}
	return result, observation, nil
}

func (f *ExtensionProviderFacade) unreadable() error {
	return circuitFailureInvocation(f.instance + ": the companion daemon's answer is not a JSON object")
}

// stream opens one streaming operation of payload on surface. A stream of
// Responses events ends with a terminal event, which the API layer checks.
func (f *ExtensionProviderFacade) stream(ctx context.Context, surface core.ModelSurface, model string, payload map[string]any) (StreamIter, error) {
	request, err := f.request(surface, model, payload)
	if err != nil {
		return nil, err
	}
	iter, err := f.runtime.core.Stream(extension.WithTimeout(ctx, f.timeout), f.caller, f.instance, request)
	if err != nil {
		return nil, extensionFailure(ctx, f.instance, err)
	}
	return &relayedStream{inner: iter, prefix: f.instance, responses: surface == core.ModelSurfaceResponses}, nil
}

func (f *ExtensionProviderFacade) ListModels() []ModelInfo {
	models, _, _ := f.ListModelsWithError()
	return models
}

func (f *ExtensionProviderFacade) ListModelsWithError() ([]ModelInfo, *CredentialObservation, error) {
	ctx, collector := collectCredentials(context.Background())
	cred, err := f.runtime.coreCredential(ctx, f.credentialVertical(), f.caller, f.instance)
	if err != nil {
		return nil, nil, err
	}
	client, err := f.runtime.instanceExtensionClient(f.instance)
	if err != nil {
		return nil, collector.Observation(), err
	}
	var models []core.ModelInfo
	if f.credentialVertical() == extensionCoreType {
		settings, _ := f.runtime.settings.Snapshot()
		info, infoErr := f.runtime.extensionProviderInfo(ctx, settings, f.instance)
		if infoErr != nil {
			return nil, collector.Observation(), infoErr
		}
		models, err = extension.NewProvider(client, info).ListModels(ctx, cred)
	} else {
		models, err = client.ListModels(ctx, f.providerID, cred)
	}
	if err != nil {
		return nil, collector.Observation(), err
	}
	return gatewayRows(models), collector.Observation(), nil
}

func (f *ExtensionProviderFacade) DefaultVoice() string {
	return "en-US-ChristopherNeural"
}

// Synthesize speaks text in voice at rate, a prosody rate such as "+20%",
// through the daemon. Its audio speech surface takes an OpenAI speech
// request, as the extension protocol carries every surface's body, so the
// voice is the request's model, the text its input and the rate its speed;
// the daemon refuses a body of bare text. The credential is the one the
// catalog is listed with.
func (f *ExtensionProviderFacade) Synthesize(voice, text, rate string) ([]byte, string, error) {
	ctx := context.Background()
	cred, err := f.runtime.coreCredential(ctx, f.credentialVertical(), f.caller, f.instance)
	if err != nil {
		return nil, "", err
	}
	client, err := f.runtime.instanceExtensionClient(f.instance)
	if err != nil {
		return nil, "", extensionFailure(ctx, f.instance, err)
	}
	speech := map[string]any{"input": text}
	if speed, ok := rateSpeed(rate); ok {
		speech["speed"] = speed
	}
	body, err := json.Marshal(speech)
	if err != nil {
		return nil, "", fmt.Errorf("marshal speech request: %w", err)
	}
	resp, err := client.Invoke(extension.WithTimeout(ctx, f.timeout), f.providerID, core.Request{
		Surface:     core.ModelSurfaceAudioSpeech,
		Model:       voice,
		Body:        body,
		ContentType: core.ContentTypeJSON,
		Credential:  cred,
	})
	if err != nil {
		return nil, "", extensionFailure(ctx, f.instance, err)
	}
	return resp.Body, resp.ContentType, nil
}

// rateSpeed is the OpenAI speech speed of a prosody rate, the inverse of the
// speed the speech API turns into one: "+20%" is 1.2 and "-50%" 0.5. A rate
// that is not a whole signed percentage has none, and is spoken at normal
// speed.
func rateSpeed(rate string) (float64, bool) {
	percent, ok := strings.CutSuffix(strings.TrimSpace(rate), "%")
	if !ok {
		return 0, false
	}
	value, err := strconv.Atoi(percent)
	if err != nil {
		return 0, false
	}
	return 1 + float64(value)/100, true
}

// extensionChat is what the Messages facade keeps of the facade: Chat and
// the catalog. It leaves out speech, which the daemon does not serve the
// provider, so the gateway does not take the facade for a speech synthesizer.
type extensionChat interface {
	Provider
	detailedCompleter
	detailedContextCompleter
	ContextStreamProvider
	detailedModelLister
}

// extensionMessagesFacade is the facade of a provider the daemon serves over
// Messages. It is a type of its own because the router sends Messages as
// they are only to a facade whose type answers them. Its Chat, which the
// daemon does not serve for the provider, is refused before anything is
// sent, and the refusal leaves an endpoint to its next member.
type extensionMessagesFacade struct {
	extensionChat
	facade *ExtensionProviderFacade
}

func (f *extensionMessagesFacade) CompleteAnthropicMessages(model string, payload map[string]any) (map[string]any, error) {
	return f.CompleteAnthropicMessagesContext(context.Background(), model, payload)
}

// CompleteAnthropicMessagesContext passes a Messages payload through with
// the preamble the API layer set, and decodes the answer with its numbers
// kept as written, as the gateway's own Anthropic facade does.
func (f *extensionMessagesFacade) CompleteAnthropicMessagesContext(ctx context.Context, model string, payload map[string]any) (map[string]any, error) {
	response, _, err := f.facade.invoke(ctx, core.ModelSurfaceMessages, model, payload)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(response.Body))
	decoder.UseNumber()
	if decoder.Decode(&result) != nil {
		return nil, f.facade.unreadable()
	}
	return result, nil
}
