# Limitations and non-goals

This page is part of the product contract. It prevents broad gateway language
from implying behavior the implementation does not provide.

## Scale and availability

- Single-node SQLite control plane with one deterministic database connection.
- No clustered state, distributed locks, horizontal scaling, or HA failover.
- No hyperscale throughput target.

## Protocol scope

- Core OpenAI Chat/Responses/models/embeddings/audio/image/video surfaces, not
  every OpenAI API or field.
- Core Anthropic Messages and token counting, not every Anthropic beta feature.
- Unsupported or lossy translated fields fail closed.
- No formal, versioned management OpenAPI yet.

## Routing

- Ordered endpoint failover, not weighted, round-robin, least-used, cost-first,
  quota-aware, reset-aware, or headroom routing.
- Prepared conversational streams commit when an upstream stream opens. Eligible
  opening failures may advance the chain; later read failures terminate it,
  even if no answer content has reached the caller. No partial-answer splicing.
- Embeddings, audio, image, and video select one eligible target.
- Provider circuit state is process-local.
- YAML retry/circuit `policies` load at startup, but circuit counters and
  cooldown state are process-local and reset on restart.

## Provider behavior

- Registry availability does not guarantee an account entitlement, deployment,
  model, region, or installed-client result.
- Google AI Studio and Vertex AI support reviewed image, PDF, audio and video
  message carriers as well as text/tools. Support depends on the model, input
  carrier and requested API; the gateway does not download or transcode remote
  references or resolve arbitrary opaque file IDs. See [provider scope](PROVIDERS.md).
- Image/video generation is implemented only by capable Google providers today.
- Upstream quota storage/advisory foundations exist, but no production quota
  adapter drives routing; unknown remains unknown.
- Estimated cost is not provider invoice reconciliation. Unknown models can
  record zero unless price overrides are configured.

## Realtime and emergency clients

- Native OpenAI-compatible WebSocket relay and WebRTC SDP creation are supported;
  signaling or opaque session traffic does not establish complete media usage.
- The limited OpenAI GA to Gemini Live profile supports manual turns, PCM16LE
  mono audio at 24 kHz, confirmed interruption, delivered-context continuation
  and correlated tools. It does not reconcile actually heard playback with
  provider history: truncation refusal/session closure is not successful
  heard-history continuation. See the [API contract](API.md).
- A gateway-first SDK with centrally delivered emergency credentials, encrypted
  cache and reconnect usage reporting is proposed, not implemented. The public
  provider roster is catalog metadata, not that emergency SDK feature.

## Client confidence

Claude Code, Codex, and Copilot CLI have fixture-backed wire profiles plus a
documented real-client UAT gate. This is not blanket certification of every
future installed client release.

## Identity and credentials

- Generic system API-key fallback is not project-binding-gated. The exact binding
  requirement applies to the supported Copilot shared-service path.
- Codex OAuth and personal Copilot OAuth are human-private.
- The gateway does not implement Claude personal-subscription OAuth.
- `secrets.json` can retain plaintext system-provider credentials for
  compatibility; not every secret is encrypted at rest.
- No browser-cookie extraction, MITM interception, or stealth session reuse.

## Console gaps

- Shared Copilot binding APIs exist without a complete primary-console editor.
- Provider `force_api_support` is configurable through YAML/API but not every UI
  form exposes it.
- Portal chat works, while capability-specific portal playground actions are not
  all registered as separate user API routes.
- Route rename uses create then delete, not an atomic rename. Key grants and
  project policies naming the old route are not migrated automatically.

## Operations

- Backups are operator-triggered and local; there is no built-in schedule or
  remote backup destination.
- Request logs are excluded from built-in backups.
- Checksums detect corruption, not archive authorship.
- `/health` proves process liveness, not provider readiness.
- Metrics, the access log and `LLMGW_RATE_LIMIT_PER_MINUTE` count per process
  and start afresh when it restarts.
- Alert delivery requires an external worker/webhook.
- The included Caddy/Compose files are not a turnkey Authentik deployment.

## Security boundary

- SSRF blocking is intentionally absent because local/LAN provider URLs are a
  core feature.
- Do not expose the raw listener publicly. Terminate TLS and enforce trusted
  identity at a reverse proxy.
- Full request-body logging can persist secrets, personal data, and proprietary
  source.

## Not on the product plan

- Universal canonical translation IR or translator marketplace.
- A 100-provider target.
- Provider quota pools, borrowing, or virtual quotas.
- Trace-console expansion or streaming account selection in the playground.
- Public hosted gateway service.
