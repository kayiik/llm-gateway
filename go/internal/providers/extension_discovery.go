package providers

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"llmgw/internal/config"

	"github.com/kayiik/llm-provider-auth/tokenstore"
	core "github.com/kayiik/llmgw-core"
	"github.com/kayiik/llmgw-core/extension"
)

const extensionCoreType = "discovered_extension"

// ExtensionProviderInfo resolves a declaration from the named extension, not
// from the gateway's curated provider registry. Declarations share the client's
// address/secret lifetime; model evidence remains separately caller-scoped.
func (rt *Runtime) ExtensionProviderInfo(ctx context.Context, extensionID, providerType string) (extension.ProviderInfo, error) {
	settings, _ := rt.settings.Snapshot()
	ext, found := settings.Extensions[extensionID]
	if !found {
		return extension.ProviderInfo{}, &ConfigError{Msg: fmt.Sprintf("extension %q is not configured", extensionID)}
	}
	ext.ID = extensionID
	return rt.extensionDeclaration(ctx, settings, ext, providerType)
}

// CachedExtensionProviderInfo returns presentation evidence without probing the
// extension. Authorization and execution resolve a current declaration instead.
func (rt *Runtime) CachedExtensionProviderInfo(extensionID, providerType string) (extension.ProviderInfo, bool) {
	settings, _ := rt.settings.Snapshot()
	ext, found := settings.Extensions[extensionID]
	if !found {
		return extension.ProviderInfo{}, false
	}
	rt.extensions.mu.Lock()
	shared := rt.extensions.clients[extensionID]
	rt.extensions.mu.Unlock()
	if shared == nil || shared.url != ext.URL || shared.secret != ext.Secret || ext.Unusable != "" {
		return extension.ProviderInfo{}, false
	}
	shared.infoMu.Lock()
	defer shared.infoMu.Unlock()
	for _, info := range shared.info.Providers {
		if info.ID == providerType {
			info.Surfaces = slices.Clone(info.Surfaces)
			info.OAuthMethods = slices.Clone(info.OAuthMethods)
			return info, true
		}
	}
	return extension.ProviderInfo{}, false
}

func (rt *Runtime) extensionProviderInfo(ctx context.Context, settings *config.Settings, instance string) (extension.ProviderInfo, error) {
	ext, err := ExtensionFor(settings, instance)
	if err != nil {
		return extension.ProviderInfo{}, err
	}
	return rt.extensionDeclaration(ctx, settings, ext, CompanionDaemonType(settings.Providers[instance]))
}

func (rt *Runtime) extensionDeclaration(ctx context.Context, settings *config.Settings, ext config.Extension, providerType string) (extension.ProviderInfo, error) {
	shared, err := rt.extensionConnection(settings, ext)
	if err != nil {
		return extension.ProviderInfo{}, err
	}
	shared.infoMu.Lock()
	defer shared.infoMu.Unlock()
	if !time.Now().Before(shared.infoUntil) {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		info, err := shared.client.Info(ctx)
		if err != nil {
			return extension.ProviderInfo{}, &ConfigError{Msg: fmt.Sprintf("extension %q: provider discovery failed; check its connection", ext.ID)}
		}
		shared.info, shared.infoUntil = info, time.Now().Add(time.Minute)
	}
	for _, info := range shared.info.Providers {
		if info.ID == providerType {
			info.Surfaces = slices.Clone(info.Surfaces)
			info.OAuthMethods = slices.Clone(info.OAuthMethods)
			return info, nil
		}
	}
	return extension.ProviderInfo{}, &ConfigError{Msg: fmt.Sprintf("extension %q does not advertise provider %q", ext.ID, providerType)}
}

func (rt *Runtime) discoveredExtensionVertical() coreVertical {
	return coreVertical{
		serves: func(_ *config.Settings, _ string, cfg *config.ProviderConfig) bool {
			return cfg != nil && strings.TrimSpace(cfg.Extension) != ""
		},
		provider: func(settings *config.Settings, instance string) (core.Provider, error) {
			info, err := rt.extensionProviderInfo(context.Background(), settings, instance)
			if err != nil {
				return nil, err
			}
			client, err := rt.extensionClientFor(settings, instance)
			if err != nil {
				return nil, err
			}
			return &extensionPreparedProvider{Provider: extension.NewProvider(client, info), client: client, info: info, runtime: rt, instance: instance}, nil
		},
		refresh: func(settings *config.Settings, instance string) tokenstore.RefreshFunc {
			info, err := rt.extensionProviderInfo(context.Background(), settings, instance)
			if err != nil || !info.HasRefresh {
				return nil
			}
			return func(ctx context.Context, current tokenstore.Record) (tokenstore.Record, error) {
				info, err := rt.extensionProviderInfo(ctx, settings, instance)
				if err != nil {
					return tokenstore.Record{}, err
				}
				if !info.HasRefresh {
					return tokenstore.Record{}, &ConfigError{Msg: fmt.Sprintf("extension provider %q does not offer credential refresh", info.ID)}
				}
				client, err := rt.extensionClientFor(settings, instance)
				if err != nil {
					return tokenstore.Record{}, err
				}
				return client.Refresh(ctx, info.ID, current)
			}
		},
		credentials: extensionCredentials{
			// Both stores share IAM records. Load records use for either kind;
			// only Resolve chooses OAuth's owner-private precedence.
			open: func() (core.CredentialStore, error) { return rt.openCredentials(true) },
			resolve: func(ctx context.Context, caller core.Caller, instance string) (string, error) {
				settings, _ := rt.settings.Snapshot()
				info, err := rt.extensionProviderInfo(ctx, settings, instance)
				if err != nil {
					return "", err
				}
				kind := info.CredentialKind()
				if kind == extension.CredentialNone {
					return "", core.ErrNoCredential
				}
				if kind != extension.CredentialOAuth && kind != extension.CredentialToken {
					return "", &ConfigError{Msg: fmt.Sprintf("extension provider %q has not reported a supported credential kind", info.ID)}
				}
				store, err := rt.openCredentials(kind == extension.CredentialOAuth)
				if err != nil {
					return "", err
				}
				key, err := store.Resolve(ctx, caller, instance)
				if errors.Is(err, core.ErrNoCredential) {
					return "", &ConfigError{Msg: fmt.Sprintf("extension provider %q requires a %s credential for this caller", instance, kind)}
				}
				return key, err
			},
		},
	}
}
