# Architecture and Modular Design

This document details the modular architecture of `llm-gateway`, the module dependency graph, ownership boundaries, extension points, testing responsibilities, and release processes.

---

## 1. Module Graph and Dependency Direction

The gateway ecosystem is split into three standalone, reusable open-source libraries and one canonical product application. Each arrow points from a module to a module it imports:

```text
                +--------------------------+
                |       llm-gateway        |
                |  (product application)   |
                +---+---------+---------+--+
                    |         |         |
                    |         v         |
                    |  +-------------+  |
                    |  | llmgw-core  |  |
                    |  | (provider   |  |
                    |  |  runtime)   |  |
                    |  +--+-------+--+  |
                    |     |       |     |
                    v     v       v     v
          +-------------------+ +-------------------+
          | llm-provider-auth | |   llm-translate   |
          |  (provider auth)  | |  (wire formats)   |
          +-------------------+ +-------------------+
```

### Dependency Rules

1. **Acyclic Hierarchy**:
   - `github.com/kayiik/llm-provider-auth` and `github.com/kayiik/llm-translate` are leaf modules with no module dependencies.
   - `github.com/kayiik/llmgw-core` depends on `llm-provider-auth` for sign-in flows, token storage and refresh, and on `llm-translate` for wire translation. It does not depend on `llm-gateway`.
   - `llm-gateway` (in `go/`) depends on all three: on `llmgw-core` for the provider runtime, and on the public packages of `llm-provider-auth` and `llm-translate` where it signs users in, stores credentials, or translates a request itself.
2. **No Reverse Dependencies**:
   - The libraries never import gateway packages or assume the gateway's SQLite schema, settings file, or console. Product state reaches them only through interfaces the gateway implements: settings sources, provider and refresh factories, credential and catalog stores, evidence sinks, OAuth flow drivers, and the catalogs and invokers of the anonymous orchestrator.
3. **Released Versions Only**:
    - `go/go.mod` requires each library directly at a release tag (`vMAJOR.MINOR.PATCH`). No `replace` directive is committed, and production builds run with `GOWORK=off`, so they resolve the published modules.
    - This is a packaging rule, not proof that the published pins contain every local addition. Cross-repository development may use an external modfile as described in [local testing](TESTING.md). A reviewed dirty checkout and a released dependency graph are separate source inputs.
4. **Enforced by Tests**:
   - `go/internal/architecture` fails when `go.mod` gains a `replace` directive or an untagged library version, when any gateway file uses a deprecated `llmgw-core` API whose replacement the gateway has adopted, or when the product adapter layer (section 3) gains a storage or configuration dependency beyond its recorded budget.
   - Go itself keeps the libraries' `internal` packages out of the gateway's reach, so the gateway uses them only through their public packages.

---

## 2. Ownership Boundaries

| Module | Canonical Repository | Primary Responsibilities |
| --- | --- | --- |
| `llm-translate` | `github.com/kayiik/llm-translate` | Finite, assessed transformations among Anthropic Messages, OpenAI Chat and Responses, including tools, supported media carriers and SSE. The `realtime` package maps the limited OpenAI GA/Gemini Live event profile; it owns no sockets, playback or billing. Zero storage or persistence. |
| `llm-provider-auth` | `github.com/kayiik/llm-provider-auth` | Upstream provider authentication: standard OAuth PKCE browser flows, GCP service account key parsing and access-token minting, the token store contract and its refresh coordinator (`tokenstore`), and bounded, secret-sanitized auth diagnostics. Zero routing, zero IAM database. |
| `llmgw-core` | `github.com/kayiik/llmgw-core` | The embeddable provider runtime: the clean provider verticals and their HTTP transports (OpenAI-compatible, Bedrock, Azure OpenAI, Anthropic API key, Google AI Studio / Vertex AI, Ollama, Keyed Zen); the `Runtime`, which resolves each request's credential, refreshes it, and replays a rejected request; the catalog service; the execution primitives for ordered failover and health tracking; the OAuth flow service; the anonymous-provider orchestrator; the client of the extension protocol; transport planning; the reviewed provider registry manifest; and the store, sink, and settings interfaces a product implements. Zero SQLite, zero console, zero operational backups. |
| Companion daemon (optional) | Distributed separately | Advertises provider IDs, native surfaces, credential kinds and sign-in methods through the extension protocol. Explicit bindings use those declarations rather than a fixed gateway vendor list. The gateway stores caller/account credentials and supplies them per operation through Core's extension client. Application metadata and explicitly enabled daemon host integrations have their own custody boundaries. |
| `llm-gateway` | `github.com/kayiik/llm-gateway` | The self-hosted application: CLI, settings, SQLite IAM/credentials/usage, ordered routing and route references, caller/key/project governance, console/portal, public provider-feed refresh, extension bindings, and adapters over the library interfaces. It owns realtime authorization, frozen target/credential binding, session orchestration and qualified usage records. |

---

## 3. Extension Points and Adapters

The gateway meets the libraries in its product adapter layer: `go/internal/providers`, `go/internal/router`, and the transport planning in `go/internal/api/transport_mode.go`. What the libraries own stays in them. Each adapter implements a library interface over gateway state, or composes a library service with gateway policy. `go/internal/architecture` records, unit by unit, why each one still reads the gateway's settings or IAM, and fails when that coupling grows.

### Adapters in `go/internal/providers`

1. **Runtime assembly** (`core_runtime.go`, `runtime.go`):
   - `core_runtime.go` builds the `llmgw-core` Runtime over the gateway's settings (`config.Source`), its credential stores, and the catalog service. Its `coreVerticals` is the registration table of the provider types core serves, one line per type.
   - `runtime.go` keeps the provider stack's state in the gateway's `Runtime` and reaches the installed one for callers that own none.
2. **Verticals** (`anthropic_vertical.go`, `audio_vertical.go`, `azure_vertical.go`, `bedrock_vertical.go`, `extension_vertical.go`, `google_vertical.go`, `ollama_vertical.go`, `openai_compatible_vertical.go`):
   - Each says which configured instances its type serves, builds the core provider of an instance, and supplies the instance's OAuth refresh and credential store. `audio_vertical.go` serves the ElevenLabs and MiMo audio types; `extension_vertical.go` serves the types of the optional companion daemon through `llmgw-core`'s extension client.
3. **Facades** (`factory.go`, `policy.go`, `anthropic.go`, `azureopenai.go`, `google_provider.go`, `googleai.go`, `ollama.go`, `openai_compatible_provider.go`, and the extension facade in `extension_vertical.go`):
   - `factory.go` builds and caches the providers the router calls, one per caller scope, each from one settings snapshot. For the types in the vertical table, a facade sends inference through the core Runtime and keeps the gateway's request shaping, error mapping, and catalog path. The extension facade also synthesizes speech through the daemon, and `googleai.go` remains the gateway's transport for Google video and catalogs.
   - `policy.go` wraps a facade in its configured retry and circuit policy, with circuits in core's `execution.HealthTracker`.
   - Their helpers: `provider.go` (the `Provider` interface), `error_classification.go` and the `*_failure.go` files (core's failures as the gateway's errors), `core_stream.go`, `httpstream.go`, `iter.go` and `linereader.go` (stream relays), `openai.go`, `openai_auth.go`, `thought_signatures.go` and `model_capabilities.go` (wire details the gateway keeps), `proxy.go` (the upstream the API layer proxies audio and embeddings to), `redact.go`, `helpers.go` (package-level wrappers over the installed Runtime and the remaining sign-in stubs), and `echo.go` (the keyless stub the dev harness and tests boot with).
4. **Stores over IAM** (`connection_store.go`, `credential_evidence.go`, `credential_observation.go`, `caller.go`):
   - `core.CredentialStore` implementations over the provider connections `internal/iam` keeps in SQLite (OAuth connections included, opened in `core_runtime.go`), the Runtime's `core.EvidenceSink`, the credential revision a check result applies to, and the IAM principal of a `core.Caller`.
5. **Catalogs** (`catalog.go`, `catalog_store.go`, `catalog_http.go`):
   - Reads, refreshes, and invalidations go through core's `catalog.Service`, keyed by caller scope, with the gateway's access checks and diagnostics. `catalog_store.go` persists catalogs in `catalog.json` as a `core.ConditionalCatalogStore`.
6. **Sign-in** (`oauth_drivers.go`):
   - The drivers of core's `oauthflow.Service`, which `internal/api` runs. The companion daemon supplies the drivers of its provider types through the extension client; the gateway has no other sign-in drivers, and the older console auth-adapter contracts in `helpers.go` remain only as stubs.
7. **Anonymous providers** (`provider_orchestrator.go`, `anonymous_profiles.go`, `anonymous_publication.go`):
   - The `Catalog` and `Invoker` of core's `anonymous.Orchestrator`, the reviewed profiles core publishes, and the gate that publishes an automation-managed model only once IAM holds its verification evidence. Enrollment policy stays in `internal/api/anonymous_provider_automation.go`.
8. **Probes and evidence** (`provider_contract_adapter.go`, `provider_evidence.go`, `quota_adapter.go`, `wire_declaration.go`):
   - The gateway's connections and checks in core's connection and evidence contracts, the quota adapter registry, and, for core's transport planning, the provider whose declarations name each facade's native surfaces.
9. **Registry** (`registry.go`, `registry_overlay.go`, `registry_overlay.json`, `registry_snapshot.json`):
   - The gateway's curation layered on core's reviewed manifest. The snapshot pins the effective registry that the documentation and website checks read.

### Other Adapters

- `go/internal/router` is routing policy: it resolves endpoints and aliases under key and project governance, filters targets by typed capability, walks a chain with core's `execution.Execute`, and records telemetry and the savings ledger. `Target` and `Resolution` alias core's types.
- `go/internal/api/transport_mode.go` plans transparent requests with core's transport helpers, `oauth_flows.go` and `server.go` run core's OAuth flow service, and `anonymous_provider_automation.go` runs the anonymous orchestrator under the gateway's enrollment policy.
- `go/internal/iam` implements `core.CredentialStore` over SQLite (`credential_store*.go`); every provider connection lives there.
- Core's `realtimews` supplies bounded JSON WebSocket transport, not protocol adaptation. Gateway's `realtime_gemini.go` serializes calls into Translate's state mapper. Confirmed interruption and continued delivered-context turns do not imply actually-heard history reconciliation; that remains unsupported in the reviewed Gemini profile.
- `internal/roster` synchronizes the public provider catalog feed. It is not an implemented emergency SDK roster, credential-distribution service or offline usage-reconciliation system.

### Extending the Gateway

- A provider that speaks an existing wire needs only a registry entry, in core's manifest or in `registry_overlay.json`.
- A new wire starts in `llmgw-core`, which owns transports and vertical semantics. The gateway then adds the type's `*_vertical.go`, its line in `coreVerticals`, and its facade in `factory.go`.
- Quota adapters register on the gateway's `Runtime` through `RegisterQuotaAdapter`; sign-in flows are the `oauthflow` drivers that `Runtime.OAuthDriver` returns.
- Quota registration and snapshot storage are foundations, not a production allowance collector or quota-aware selection pipeline. No provider/model local-cap feature follows merely from request/key quota support.

---

## 4. Testing Responsibilities

Each layer maintains dedicated test boundaries:

1. **Module Unit Tests**:
   - `llm-translate`: Bidirectional wire mapping fidelity, streaming SSE deltas, tool translation parity, and synthetic response tests.
   - `llm-provider-auth`: Token exchange, device polling state machines, PEM parsing, secret leak prevention, and diagnostic text bounds.
   - `llmgw-core`: Provider verticals and transports against fixture upstreams, the Runtime's credential resolution, refresh, and replay, failover and health tracking, transport planning, and the conformance suites a product runs against its own stores (`catalogtest`, `oauthflowtest`).
2. **Gateway Unit and Integration Tests**:
   - Run via `go test ./...` in `go/`.
   - Tests CLI commands, SQLite IAM migrations, encrypted credential storage, quota enforcement, catalog synchronization, and API surface routing.
   - `internal/api/testdata/characterization` pins the gateway's HTTP behavior and upstream requests; `internal/providers` runs core's `catalogtest` suite against `catalog.json`; `internal/architecture` enforces the rules of section 1.
3. **Console Verification**:
   - Run in `go/internal/web/console`.
   - Typechecking (`npm run lint`), component tests (`npm test`), dependency security audits (`npm audit --audit-level=high`), and distribution drift check (`npm run check:dist`).
4. **Deterministic Acceptance Testing**:
   - Automated via `test/live-acceptance/run.mjs` in deterministic mode.
   - Spins up clean isolated containers against mocked backends to verify Docker health, catalog sweeps, chat/streaming evidence, route failover, and restart persistence.
5. **Live Acceptance Testing**:
   - Release gating harness verifying live provider connectivity, token usage, and error attribution.

---

## 5. Release and Distribution Process

1. **Library Versioning**:
   - Standalone libraries publish semantic version tags independently (`vMAJOR.MINOR.PATCH`).
   - Library updates are pushed to their respective public repositories and verified with `go vet`, `go test`, and `govulncheck`.
2. **Gateway Dependency Pinning**:
   - `go/go.mod` consumes published library tags directly via standard Go module resolution, with no `replace` directives.
   - `go mod tidy -diff` must produce zero differences.
3. **Release Binaries and Container**:
   - Release workflow (`.github/workflows/release.yml`) builds eight cross-compiled OS/architecture binaries (`windows/amd64`, `windows/arm64`, `linux/amd64`, `linux/arm64`, `linux/riscv64`, `darwin/amd64`, `darwin/arm64`, `freebsd/amd64`) with `CGO_ENABLED=0`.
   - Multi-architecture container images (`linux/amd64`, `linux/arm64`) are built from `go/Dockerfile` with SBOM generation and SLSA provenance attestation.
   - A version tag push validates the release identity, runs CI, builds the binaries, stages a draft release, publishes a candidate image, and runs live acceptance against it; only then is the image promoted to its immutable version tag and the draft published. The image dry run runs only on manual dispatch, which never publishes; publication does not depend on it.
