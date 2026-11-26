package providers

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	gcpauth "github.com/kayiik/llm-provider-auth/gcp"
	core "github.com/kayiik/llmgw-core"
	coreproviders "github.com/kayiik/llmgw-core/providers"

	"llmgw/internal/config"
	"llmgw/internal/googlecredential"
)

// Catalog discovery, embeddings and Google's other surfaces retain their
// original transport. Only Chat selects the publisher's OpenAI wire.
type vertexOpenAIChat struct {
	*coreproviders.Google
	instance, project, location, requestType string
	client                                   *http.Client
	tokens                                   *gcpauth.TokenCache
}

var vertexChatLocation = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// VertexOpenAIChatLocation validates the endpoint before the management API
// saves credentials and before a file-configured provider can use them.
func VertexOpenAIChatLocation(providerType, location, baseURL string) (string, error) {
	if !strings.EqualFold(providerType, "vertex_ai") {
		return "", &ConfigError{Msg: "vertex_openai_chat requires a Vertex AI provider"}
	}
	loc := strings.TrimSpace(location)
	if loc == "" {
		loc = vertexDefaultLocation
	}
	if !vertexChatLocation.MatchString(loc) {
		return "", &ConfigError{Msg: "vertex_openai_chat: invalid Vertex location"}
	}
	// A configured catalog proxy must never become the destination of a minted
	// Google token merely because an operator enabled this transport.
	canonical := "https://" + vertexHost(loc) + "/" + vertexDefaultAPI
	if base := strings.TrimRight(strings.TrimSpace(baseURL), "/"); base != "" && base != canonical {
		return "", &ConfigError{Msg: "vertex_openai_chat requires the standard Google Vertex endpoint"}
	}
	return loc, nil
}

func (rt *Runtime) vertexChatProvider(native *coreproviders.Google, instance string, cfg *config.ProviderConfig) (*vertexOpenAIChat, error) {
	loc, err := VertexOpenAIChatLocation(cfg.Type, cfg.Location, cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	accounting := ""
	switch strings.ToLower(strings.TrimSpace(cfg.VertexRequestType)) {
	case "", "default":
	case "paygo":
		accounting = "shared"
	case "dedicated":
		accounting = "dedicated"
	default:
		return nil, &ConfigError{Msg: "invalid Vertex request type"}
	}
	client := providerClient(googleTimeout(cfg.TimeoutOr(120)).Seconds())
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &vertexOpenAIChat{Google: native, instance: instance, project: strings.TrimSpace(cfg.Project),
		location: loc, requestType: accounting, client: client, tokens: &rt.gcpTokens}, nil
}

func (p *vertexOpenAIChat) account(c *core.Credential) (*gcpauth.Credential, error) {
	if c == nil || c.TokenType != core.TokenTypeGCPServiceAccount {
		return nil, &ConfigError{Msg: "vertex_openai_chat requires a Google service-account credential"}
	}
	account, err := googlecredential.Parse(c.Token)
	if err != nil {
		return nil, &ConfigError{Msg: "vertex_openai_chat: invalid service-account credential"}
	}
	if (p.project != "" && account.ProjectID() != p.project) || (c.Metadata[core.CredentialMetadataProjectID] != "" && c.Metadata[core.CredentialMetadataProjectID] != account.ProjectID()) {
		return nil, &ConfigError{Msg: "vertex_openai_chat: service account and configured project must match"}
	}
	return account, nil
}

// Vertex's OpenAI endpoint authenticates with OAuth. An existing API-key
// connection retains its native Google transport and cannot borrow another
// caller's service account.
func vertexChatWire(r core.Request) bool {
	return r.Surface == core.ModelSurfaceChatCompletions && r.Credential != nil && r.Credential.TokenType == core.TokenTypeGCPServiceAccount
}

func (p *vertexOpenAIChat) PrepareCall(ctx context.Context, r core.Request, o core.CallPreparationOptions) (core.PreparedCall, error) {
	if !vertexChatWire(r) {
		return p.Google.PrepareCall(ctx, r, o)
	}
	account, err := p.account(r.Credential)
	if err != nil {
		return nil, err
	}
	project := account.ProjectID()
	base := "https://" + vertexHost(p.location) + "/" + vertexDefaultAPI + "/projects/" + url.PathEscape(project) +
		"/locations/" + p.location + "/endpoints/openapi"
	wire, err := coreproviders.NewOpenAICompatible(coreproviders.OpenAICompatibleConfig{
		BaseURL: base, Client: p.client, ForwardAllFields: true,
	})
	if err != nil {
		return nil, err
	}
	model := r.Model
	id := strings.TrimPrefix(strings.TrimSpace(model), "models/")
	r.Model = "google/" + strings.TrimPrefix(id, "google/")
	// The wire provider needs its bearer only at execution. The coordinator
	// checks the original credential scope and revision before rebinding it.
	r.Credential = nil
	inner, err := wire.PrepareCall(ctx, r, o)
	if err != nil {
		return nil, err
	}
	bearer := func(c *core.Credential) (*core.Credential, error) {
		current, err := p.account(c)
		if err != nil {
			return nil, err
		}
		if current.ProjectID() != project {
			return nil, core.ErrPreparedCallStale
		}
		token, err := p.tokens.AccessToken(current, gcpauth.CloudPlatformScope)
		if err != nil {
			return nil, vertexTokenFailure(p.instance, err)
		}
		access := &core.Credential{Token: token, TokenType: "Bearer"}
		if p.requestType != "" {
			access.Headers = map[string]string{"X-Vertex-AI-LLM-Request-Type": p.requestType}
		}
		return access, nil
	}
	d := inner.Description()
	d.Model, d.Deployment, d.APIVersion = model, "vertex_openai_chat", vertexDefaultAPI
	return core.NewPreparedCall(d, func(ctx context.Context, c *core.Credential) (core.Response, error) {
		current, err := bearer(c)
		if err != nil {
			return core.Response{}, err
		}
		return inner.Invoke(ctx, current)
	}, func(ctx context.Context, c *core.Credential) (core.StreamIter, error) {
		current, err := bearer(c)
		if err != nil {
			return nil, err
		}
		return inner.Stream(ctx, current)
	}), nil
}

func (p *vertexOpenAIChat) Invoke(ctx context.Context, r core.Request) (core.Response, error) {
	if !vertexChatWire(r) {
		return p.Google.Invoke(ctx, r)
	}
	call, err := p.PrepareCall(ctx, r, core.CallPreparationOptions{Mode: core.CallModeInvoke})
	if err != nil {
		return core.Response{}, err
	}
	return call.Invoke(ctx, r.Credential)
}

func (p *vertexOpenAIChat) Stream(ctx context.Context, r core.Request) (core.StreamIter, error) {
	if !vertexChatWire(r) {
		return p.Google.Stream(ctx, r)
	}
	call, err := p.PrepareCall(ctx, r, core.CallPreparationOptions{Mode: core.CallModeStream})
	if err != nil {
		return nil, err
	}
	return call.Stream(ctx, r.Credential)
}
