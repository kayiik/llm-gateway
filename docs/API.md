# Data-plane API

The gateway exposes core OpenAI- and Anthropic-shaped HTTP surfaces. It does not
claim every endpoint or field in either vendor API.

## Authentication

`GET /health` is unauthenticated. Other public data-plane routes accept:

- `x-api-key: <gateway key>`;
- `Authorization: Bearer <gateway key>`.

When both are present, `x-api-key` takes precedence. An invalid `x-api-key` is
not rescued by a valid bearer token. Active gateway-issued project keys are
accepted; give them to clients. The static administrator keys (`LLMGW_API_KEY`,
`LLMGW_API_KEYS`) are also accepted but bypass key and project allowlists and
quotas; this is deprecated, and `LLMGW_ADMIN_KEYS_ON_DATA_PLANE=false` refuses
them with `403`. `LLMGW_ALLOW_UNAUTHENTICATED_API=1` disables only data-plane
authentication and is for deliberate local use; admin authentication remains
required. In that mode any token, or none, is accepted, and browser requests
from a non-loopback `Origin` are refused with `403`; see
[unauthenticated local mode](CONFIGURATION.md#unauthenticated-local-mode).

## Routes

| Method | Canonical path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Process liveness and build identity. It does not probe providers or database freshness. |
| `GET` | `/v1/models` | Configured, credential- and policy-eligible models, endpoint pseudo-models, and unambiguous aliases. |
| `POST` | `/v1/chat/completions` | OpenAI-shaped chat, tools, streaming, usage, and vision target filtering. |
| `POST` | `/v1/responses` | Native Responses or strict compatible stateless Chat fallback. |
| `POST` | `/v1/messages` | Native Anthropic Messages or strict Chat adaptation. |
| `POST` | `/v1/messages/count_tokens` | Native count when supported; otherwise a marked deterministic estimate. |
| `POST` | `/v1/embeddings` | Single-target OpenAI-shaped embedding proxy. |
| `POST` | `/v1/audio/transcriptions` | Multipart single-target speech-to-text proxy. |
| `POST` | `/v1/audio/speech` | Single-target speech synthesis, including native Edge TTS. |
| `POST` | `/v1/realtime/calls` | Native multipart WebRTC SDP/session signaling. |
| `GET` | `/v1/realtime?model=…` | Native WebSocket relay or explicitly permitted bounded Gemini Live adaptation. |
| `POST` | `/v1/images/generations` | Image generation from a capable provider; returns inline `b64_json`. |
| `POST` | `/v1/videos/generations` | Starts a video operation or polls one when `operation` is supplied. |

## Bare aliases

The same handlers accept:

```text
/models
/chat/completions
/responses
/completions              -> Chat Completions, not legacy Completions
/messages
/messages/count_tokens
/embeddings
/audio/transcriptions
/audio/speech
/realtime/calls
/realtime
/images/generations
/videos/generations
```

There is no `/v1/completions` route.

## Models

The request `model` is an exact `provider/model`, named endpoint, or advertised
bare alias. Response model fields identify what actually served the request.
Catalog inclusion proves caller-scoped routing eligibility, not fresh provider
discovery, current inference health, or the caller's upstream entitlement.

`GET /v1/models` returns only configured rows eligible under the caller's
credential and policy. It is not a global list of every model a provider sells.

## Chat Completions

### Native and compatible execution

Direct `provider/model` requests and bare aliases default to the deployment's
actual native API. An OpenAI-shaped adapter in front of Google `generateContent`
or Ollama `/api/chat` is an adaptation, even when ordinary text converts without
loss. A deployment implementing Chat Completions itself is native regardless of
its provider brand. Unknown underlying APIs are not assumed to be native.

`X-LLMGW-Compatibility: allow` explicitly permits an assessed conversion for a
direct request; `deny` requires native execution. Named routes instead use their
configured `ingress` and `allow_adaptation` contract. Request `allow` cannot
broaden that contract, while `deny` can tighten it. Repeated, empty, combined or
invalid policy values fail before inference. These rules also apply to the
built-in playground.

`X-LLMGW-Transport-Mode: transparent` is a separate, stronger requirement for an
exact, catalog-confirmed target and wire-preserving transport. It cannot be
combined with compatibility `allow`; transparent streaming remains unsupported.
Actual-native execution does not itself promise byte-for-byte wire preservation.

Preparation checks the concrete payload before consuming an inference request
slot. Execution uses that selected API and mapping, bound to the caller,
credential scope and configuration generation. A changed binding requires a new
request. It does not silently switch APIs or strip rejected controls. Once a
stream opens, a failure cannot replay it against another target.

The core profile supports non-streaming and SSE streaming, ordinary chat
messages, function tools, tool calls, usage normalization, vision filtering, and
request cancellation. A streaming request's `stream_options` reaches the
upstream, so `include_usage` returns the stream's usage where the upstream
reports it. Ordered endpoint failover is possible before output
starts. Chat Completions, Responses, and Messages accept request-level controls
for the failover deadline and member order; see
[failover budget and affinity](ROUTING.md#failover-budget-and-affinity).

`force_api_support` is a legacy endpoint-rewrite control, not compatibility
authorization. It cannot override native-only policy. `X-LLMGW-Transport-Mode`
describes the selected native or translated execution; a model listing or an
empty conversion-loss report does not prove native support.

### Request fields

`fallback_timeout_ms`, `affinity_key`, and `force_api_support` are the
gateway's own and never reach the upstream. Every other field, including
`response_format`, `n`, `seed`, `logprobs`, `parallel_tool_calls`, `user`, and
fields the gateway does not know, reaches an OpenAI-compatible, OpenAI, or
LiteLLM target unchanged, in transparent mode too. Other targets send what their
wire carries:

| Target | Fields sent besides `model`, `messages`, `stream`, and `stream_options` |
| --- | --- |
| OpenAI-compatible, OpenAI, LiteLLM | Every field. |
| Bedrock | `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `tools`, `tool_choice`, `reasoning_effort`, `metadata`, `parallel_tool_calls`, `thinking`. |
| Explicitly extension-bound provider | Every native request field; the extension owns upstream mapping and losses. |
| Azure OpenAI | Every request property of Azure's v1 Chat Completions, and `service_tier`: `audio`, `frequency_penalty`, `function_call`, `functions`, `logit_bias`, `logprobs`, `max_completion_tokens`, `max_tokens`, `metadata`, `modalities`, `n`, `parallel_tool_calls`, `prediction`, `presence_penalty`, `prompt_cache_key`, `prompt_cache_retention`, `reasoning_effort`, `response_format`, `safety_identifier`, `seed`, `service_tier`, `stop`, `store`, `temperature`, `tool_choice`, `tools`, `top_logprobs`, `top_p`, `user`, `user_security_context`, `verbosity`. |
| Explicitly permitted Chat adaptation to a Responses-only model | `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `tools`, `tool_choice`, `metadata`, `reasoning_effort`, and `response_format` as the Responses `text.format`, subject to assessment of their concrete values. |
| Anthropic | `temperature`, `top_p`, `max_tokens`, `stop`, `tools`, `metadata`, `thinking`, `output_config`. |
| Google AI Studio, Vertex AI | `temperature`, `max_tokens`, `tools`, `tool_choice`, and a `response_format` of type `json_object` or `json_schema`, which reaches Gemini as its structured output, the schema as written. |
| Ollama | `temperature`, `top_p`, `max_tokens`, `tools`. |

Anthropic, Google and Ollama targets read `max_completion_tokens` as their
output limit when `max_tokens` is unset. Google targets send function tools
only, and a `tool_choice` of `auto`, `none`, `required`, or a function the
request declares; tool calls come back with Gemini's thought signature at
`extra_content.google.thought_signature`, which a client returns on its next
turn.

Extension native surfaces and sign-in methods come from its discovery response,
not a gateway vendor table or the extension implementation's release number.

A request that sets a field whose loss would change the answer, and that its
target does not send, fails with `400` naming the field before anything is sent;
for example `response_format`, `n` above 1, `logprobs`, `stop`, or `tools` on a
target that cannot carry them. Compatibility permission does not authorize loss
of schema constraints, billing/cache controls, or opaque continuation state.
Unassessed required semantics also refuse an adapting target. Native unknown
fields may pass through for upstream validation; that is not a guarantee of
model support. Display-only reasoning omissions may remain advisory. A value
that asks for nothing does not count either:
`null`, `false`, an empty value, `n: 1`, a zero `top_logprobs`, a
`response_format` of type `text`, text-only `modalities`, `tool_choice: "auto"`,
and `parallel_tool_calls: true`. In an endpoint, a member that cannot send a
field is skipped as capability filtering skips one, and the request fails only
when no member can send it. Field names that begin with `_` are reserved and
refused.

## Responses

Native Responses targets preserve the Responses envelope and streaming events.
Explicitly compatible stateless requests can select a strict Chat translation
during preparation. An unavailable selected Responses endpoint is an upstream
failure, not permission to discover and retry a different API after dispatch.
The fallback sends a `text.format` as `response_format` to a target that sends
that Chat field, as listed above, and the answer carries the format back; a
`text.format` of type `text` asks for nothing and is served everywhere. A
target the fallback cannot serve a request through, because the translation
would lose part of it or the target cannot send what it carries, is sent
nothing. In an endpoint the next member is tried, which may serve the request
natively, and the request fails with `400` only when no member serves it.

`background: true` is rejected even for native targets. Built-in tools, non-empty `include`,
reasoning summaries, encrypted reasoning state, and other stateful behavior
require a native Responses target with the specific capability and account
entitlement. Native transport alone is not a compatibility guarantee. Stateful requests require an exact model and
a private human connection; route failover cannot preserve provider state.

## Anthropic Messages

Native Anthropic targets receive non-streaming Messages payloads directly after
resolved-model and gateway-preamble changes. Adapted targets reject unsupported
or lossy fields before dispatch.

A stream served by a native Anthropic member is sent the same way,
with `stream: true`, and each record the target sends reaches the client
unchanged, `ping` and thinking deltas included. Its usage is read from those
records: input and cache tokens from `message_start`, output tokens from
`message_delta`. Other members do not force this native member through a
conversion. A stream served by an explicitly permitted adapted member uses a narrower
compatibility profile: adaptive/enabled thinking, `redacted_thinking`, cache
controls, structured output, documents, unsupported images, error tool results,
and unknown fields fail closed when they cannot be preserved.

## Media inputs

Native Chat Completions, Responses and Messages retain their API's ordered
content arrays, file references and media controls, including through native
companion-daemon transport. A native input is passed to the selected provider
for model-specific validation; the gateway does not decode videos or transcode
audio to forward a request.

OpenAI-compatible targets and the Bedrock compatible endpoint share this
native content-part transport. Accepted modalities are still specific to the
model and API. The Bedrock integration uses its compatible Chat/Responses
surfaces; native AWS Converse/InvokeModel and bidirectional speech APIs are
separate interfaces and are not implemented by that adapter.

Explicitly permitted adaptations support these carriers:

- Chat `file` parts and Responses `input_file` parts map `filename`,
  `file_data` and `file_id` between the nested and flat envelopes. Exactly one
  data/ID carrier is required. Responses `file_url` stays native-only because
  Chat has no equivalent URL field.
- Messages user images with base64 or URL sources map to Chat image parts.
  A base64 `application/pdf` document maps to a Chat file. Document titles,
  citations, context and cache controls still require a native Messages target
  when that adapting path cannot retain them.
- Google AI Studio and Vertex Gemini preserve ordered user text/media parts.
  Inline images and typed file data become `inlineData`; remote media URIs
  become `fileData` without a gateway-side fetch. PDF, audio and video use the
  same documented MIME/data carriers. Chat `input_audio` requires explicit
  `wav` or `mp3` format. A bare file's MIME type can be derived from a recognized
  filename; a data URL carries its own type. Opaque provider file IDs are not
  interpreted as Google file URIs.
- Ollama receives inline base64 user images in its native `images` list, in
  image order, alongside the message text. Remote images and non-default image
  detail require a different/native target rather than a hidden download or
  silently dropped control.

Unsupported carriers and unmapped nested controls fail during preparation.
These mappings retain the existing native-first policy; they do not enable
adaptation implicitly or change a model's declared input capabilities.

## Source usage evidence

Recorded request listings include optional `source_usage` evidence for prepared
operations and explicitly scoped signaling requests. Older rows and providers
without an observation interface omit it.
Its versioned object contains accounting bases, incomplete/invalid flags, a
bounded attempt history and the `selected_attempt` index used by the legacy
aggregate counters. Attempts retain the actual upstream API, provider/model,
source completion quality and cancellation state. If a later target fails before
making a native attempt, earlier history remains available with
`selection_unavailable: true` and `selected_attempt: -1`; it is not relabeled as
that later target's measured usage. Counts preserve presence,
provenance and source paths for totals, cache/reasoning, audio/prediction details
and reported web-tool requests. Detail counters are not added to their parent
totals again.

Reported zero is distinct from absence and overrides an estimate. Client
`include_usage` controls target wire emission, not collection for accounting.
When native Messages omits cache categories, inclusive input remains absent;
the legacy input aggregate may use observed base/cache counts as an explicitly
incomplete lower bound. Reported cumulative output on a failed or truncated
source is likewise marked partial rather than presented as a final total.
Estimates remain labeled when no native count was reported.

Invalid provider counts/relationships are retained diagnostically without
settling token, money or credit counters. Evidence contains recognized counts
and fixed scalar usage fields; arbitrary provider payloads are excluded.
History and raw truncation are explicit. Native retry/fallback observations stay
separate rather than being summed as cumulative frames or priced as though they
all belonged to the selected model. A response-conversion failure retains the
original attempt's usage and source completion independently of delivery status.
Final stream observations are recorded after closure, not fabricated in
stream-open HTTP headers.

## Token counting

Native Anthropic counting uses the first eligible target. Other targets receive a
compact-JSON estimate marked by `X-LLMGW-Token-Count: estimate` without an
upstream inference call. Counting does not consume inference quotas or write a
usage event. Its request bodies are limited to 32 MiB, or to the general
[request size limit](#request-size) when that is lower.

## Embeddings

Embeddings deliberately use one target. Falling back to a different embedding
model would return vectors from another vector space and silently corrupt search
quality. The handler still enforces authentication, routing eligibility, policy,
and usage accounting.

## Audio

Transcription accepts multipart form data with `file` and `model`. Speech accepts
an OpenAI-shaped JSON body. OpenAI-compatible providers receive proxied requests;
extensions can declare native audio surfaces through discovery. The
`nvr-tts-*` voices of an OVHcloud AI Endpoints instance speak WAV at their own
hosts: the model names the language, and `voice` is one of that language's
voices, such as `English-US.Male-1`, or else its base voice speaks.

Audio resolves one target. Transcription uploads count against the
[request size limit](#request-size).

Direct OpenAI-compatible audio proxies forward successful response bytes as
they arrive, preserving the upstream content type. Speech can return binary
audio (`stream_format: "audio"`, the upstream default) or audio events
(`stream_format: "sse"`) where the selected endpoint/model supports them.
Multipart transcription `stream=true` requests transcript SSE. The proxy also
retains `chunking_strategy` and repeated `include[]`,
`timestamp_granularities[]`, `known_speaker_names[]` and
`known_speaker_references[]` fields. Query values retain their existing
precedence over multipart fields.

Buffered native provider adapters reject an explicitly requested SSE mode
instead of ignoring it. Immediate upstream failures use the normal safe JSON
error envelope. After audio bytes have been delivered, a transport failure
aborts the HTTP response rather than appending JSON to audio or replaying the
request. Client cancellation closes the upstream, and the request's recorded
outcome is finalized when forwarding ends. These HTTP audio streams are
distinct from the separate realtime WebRTC/WebSocket session APIs.

## Realtime WebRTC signaling

`POST /v1/realtime/calls` implements the
[native call-creation contract](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create).
Supply multipart `sdp` and `session` fields once each. The session is a JSON
object with `type: "realtime"` and a `model` naming an exact provider/model,
alias or route. Other session fields, including audio settings, instructions,
tools and provider extensions, retain their values; routing replaces only the
model selector with the selected upstream model.

```bash
curl "$LLMGW_URL/v1/realtime/calls" \
  -H "Authorization: Bearer $LLMGW_PROJECT_KEY" \
  -F 'sdp=<offer.sdp;type=application/sdp' \
  -F 'session={"type":"realtime","model":"voice","audio":{"output":{"voice":"marin"}}};type=application/json'
```

The selected registered OpenAI-compatible HTTP transport sends the request to
its configured base URL's `/realtime/calls`. Current explicit model API
declarations constrain selection; missing or expired evidence remains unknown
for upstream validation. Native signaling uses no Chat/Responses conversion.
Routes with an ingress list must include `/v1/realtime/calls`. One selected
target receives one creation request, and an upstream failure is returned to
the caller rather than replaying session creation.

The successful upstream status and SDP bytes are returned with their SDP/plain
text content type. A valid `Location` retains its call ID at a gateway-relative
path. This handler covers creation; server-side call control, sideband events
and the separate `/live/sessions` API are follow-up work. The independent
WebSocket entrypoint is described below.
Clients manage the peer connection and data channel using the provider's protocol.

The gateway applies normal key/project routing and request admission at
creation, recording a project-attributed signaling request. The response carries
`X-LLMGW-Usage-Scope: signaling`. WebRTC media and data-channel usage events travel
between client and provider, so the gateway does not observe their token counts
or final session cost through this HTTP exchange. Recorded source evidence uses
`unobserved_session` bases, incomplete flags and a signaling attempt with unknown
completion quality and absent counters. Legacy zero aggregates are not measured
zero-token sessions. Ongoing media token/cost enforcement requires a separate
session-usage observation path.

SDP contains ICE credentials. Signaling bodies are excluded from request/response
body logs even when general body logging is enabled; metadata and byte counts remain.

## Realtime WebSocket relay

Connect an OpenAI-native WebSocket client to
`ws://<gateway>/v1/realtime?model=<provider/model-or-route>` (use `wss` behind TLS).
Authenticate with a gateway project key in `Authorization: Bearer …` or
`x-api-key`; the gateway resolves the selected provider credential separately.
Exactly one `model` query parameter is accepted. Query-string keys, browser
subprotocol authentication, session-resumption endpoints and transcription-only
handshakes without a model are not implemented.

The gateway applies normal caller, provider, model, route and request-quota
policy before opening one upstream connection. Explicit route ingress must
include `/v1/realtime`; `/v1/realtime/calls` alone does not grant it. A compatible
provider's configured HTTP(S) base URL supplies the upstream `/realtime` path,
with the selected model in its query. Current explicit API declarations constrain
selection; missing or expired evidence remains unknown for upstream validation.
AI Studio/Gemini Live is a different native protocol. The bounded adaptation
profile below is opt-in, not an implicit native fallback.

After a validated upgrade, native text, binary, audio, tool and control frames
pass without event conversion. Gateway credentials, cookies and routing headers
are not forwarded; only provider credentials and the required handshake headers
reach the upstream. The optional `OpenAI-Beta` header and negotiated WebSocket
compression are retained. There is no redirect, reconnect, retry, target switch
or replay after dispatch. A disconnect/cancellation closes the relay; each
connection also has a fixed 30-minute maximum lifetime. Transparent transport
mode is refused. Native transport remains preferred over adaptation.

Request admission is counted once. The handshake carries
`X-LLMGW-Usage-Scope: unobserved_session`; the ledger records the selected attempt
and final relay duration but marks token/cost evidence incomplete with absent
counters, rather than inventing a zero-token session. This opaque transport does
not aggregate usage events or enforce a measured ongoing session token budget.
Session frames are never captured by HTTP body logging. Failed handshakes retain
upstream refusal status and safe `Retry-After`, with sanitized response bodies.

### Bounded Gemini Live adaptation

For an exact AI Studio target, explicitly request `X-LLMGW-Compatibility: allow`.
For a route, its contract must declare `/v1/realtime` ingress and
`allow_adaptation: true`; a request cannot override a route's denial. Explicit
native/transparent requirements never enable adaptation. Vertex and extension
bindings do not acquire this transport by sharing a model name. No configured
model is changed or inferred to support Live: the selected endpoint validates it.

This representative server-to-server profile uses OpenAI GA-style nested
`session.audio` settings and `response.output_audio.*` events, not every SDK or
all OpenAI controls. The handshake identifies it as
`X-LLMGW-Realtime-Profile: openai-ga-gemini-live-manual-pcm`. Send one initial
`session.update` with these audio settings:

```json
{"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":null},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"Puck"}},"output_modalities":["audio"]}
```

The payload above is the `session` object, optionally with `type: "realtime"`,
instructions and supported function declarations. If supplied, `session.model`
must match the selected upstream model; omit it when connecting through an alias.
PCM is mono, signed 16-bit little-endian, base64 encoded, at 24 kHz in both
directions. Input bytes are forwarded unchanged with `audio/pcm;rate=24000`.
Gemini's [documented input resampling](https://ai.google.dev/gemini-api/docs/live-guide#audio-formats)
accepts this rate even though its native input rate is 16 kHz; the gateway does
not relabel 24 kHz samples as 16 kHz or add a local resampler. Output stays at
24 kHz without conversion. A client-declared 16 kHz input is not this GA profile.
`Puck` is explicitly a Gemini voice, not a silent replacement for `marin` or
another OpenAI voice. Wait for actual upstream setup confirmation before sending
audio. Append audio, commit it, then send `response.create` to own the manual
turn boundary. Function-call arguments/results retain call identities; the client
executes tools, submits `function_call_output`, then creates the next response.
Unsupported controls, schema constraints, VAD, session updates and codecs are
refused rather than dropped.

**Exact played-history interoperability is not supported.** Google's documented
interruption retains audio **sent to the client**; OpenAI WebSocket truncation
reconciles audio actually **played**. The reviewed public Live protocol exposes
no corresponding playback-cursor/history-edit request. The bridge must not emit
a successful `conversation.item.truncated` for a local-only queue edit; unsafe
history reconciliation requests are explicitly refused and can require closure.
Manual interruption/continuation does not change this distinction. Treat this as
a limited protocol increment, not a complete replacement for an OpenAI voice
client requiring exact heard-context continuity. See the primary
[Google interruption guide](https://ai.google.dev/gemini-api/docs/live-guide#voice-activity-detection-vad),
[Live wire reference](https://ai.google.dev/api/live), and
[OpenAI conversation reference](https://developers.openai.com/api/docs/guides/realtime-conversations).

The bridge bounds JSON text messages to 1 MiB and one connection to 30 minutes,
without redirect, reconnect, retry or hidden context replay. Caller-bound Google
credentials stay in an upstream header. Usage remains explicitly
`unobserved_session`; local PCM/event fixtures establish protocol handling, not
provider speech quality, actual model compatibility, live billing or a measured
ongoing token budget. WebRTC media conversion is not implemented by this profile.

## Images and video

Image output is returned inline as base64 and supports only
`response_format: b64_json` or an omitted format. Native generation is currently
implemented by capable Google AI Studio/Vertex providers.

Video start returns `202` with an operation ID. Poll with the same model selector
and the `operation` value. Canceling the HTTP request does not cancel an upstream
job after the operation was created.

When an AI Studio job completes with a file resource on its configured API
origin, the gateway downloads it using that request's provider credential and
returns `video_base64`, `video_bytes`, and `mime_type` for the console player.
Downloads use the provider response-size bound and do not follow redirects.
Other result locations remain `video_uri` metadata; provider credentials are
never appended to the URI or sent to another origin.

## Request size

Request bodies are limited to 64 MiB unless `LLMGW_MAX_REQUEST_BODY_BYTES`
[changes the limit](CONFIGURATION.md#server-and-state). A larger body is refused
with `413` in the route's error envelope: before it is read when it declares a
`Content-Length`, and as soon as it crosses the limit otherwise. Multipart
uploads count in full. The same limit bounds the management APIs.

## Request IDs

Every response carries an `X-Request-Id` header naming its request, errors
included; a stream carries it before its first event. A client may name its
own request by sending `X-Request-Id` with 1 to 128 letters, digits, `.`, `_`,
`:` or `-`, and the response carries that value back. Without one, or with any
other value, the gateway assigns an ID: `req_` followed by 32 hexadecimal
digits.

Quote the ID when reporting a failed request: it is how an operator finds the
request's usage record, request log entry and audit event; see
[correlating a request](OPERATIONS.md#correlating-a-request). Send a different
ID for every request, retries included. A usage record's ID is unique, so a
request that repeats an ID an earlier one was recorded under is recorded under
an ID the gateway assigns instead.

## Errors and cancellation

Upstream errors preserve meaningful status while credential-shaped diagnostics
are sanitized. Client cancellation on covered coding endpoints stops upstream
work and suppresses success terminals, retry, and failover after abort.

Errors on `/v1/messages` and `/v1/messages/count_tokens` use Anthropic's
envelope,
`{"type":"error","error":{"type":...,"message":...},"request_id":...}`, with
the HTTP status and any `Retry-After` header kept. The type follows the status:
`invalid_request_error` for `400`, `413` and `422`, `authentication_error` for
`401`, `permission_error` for `403`, `not_found_error` for `404`,
`rate_limit_error` for `429`, `overloaded_error` for `529`, and `api_error` for
other `5xx`. Other routes use
`{"error":{"message":...,"type":...,"code":...,"request_id":...}}`. In both,
`request_id` repeats the response's `X-Request-Id`.

A stream whose upstream fails after the first byte, or closes the stream
before its end, ends with the surface's error event and never with its success
terminal: Chat Completions sends an `error` data event without `[DONE]`,
Messages sends `event: error` without `message_delta` or `message_stop`, and
Responses sends `response.failed`. A native Messages stream whose upstream
sent its own `event: error` ends with that one. Usage records such a stream as
a `502`.

## Management APIs

`/admin/api/*` and `/user/api/*` power the embedded console and portal. They are
authenticated but do not yet have a formal, versioned management OpenAPI
contract. External automation should expect those routes to evolve until such a
contract is introduced.
