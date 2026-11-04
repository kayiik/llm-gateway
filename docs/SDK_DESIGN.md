# Gateway client SDK design

Status: a bounded JSON and text-SSE slice exists in `sdk/` and
`go/internal/api/client_snapshot.go`. The rest of this page describes the
target contract, not a claim that every tool, media, or provider-specific
stream is qualified. See [the SDK quickstart](../sdk/README.md) for the precise
implemented subset.

## Goal and inspiration

Ship first-party Node.js, Python, and Go clients. Each installation configures
one gateway URL and one gateway-issued project key, then can call many eligible
models and named endpoints. Calls go to the live gateway normally. Local calls
use a cached, key-scoped connection snapshot **only when the gateway is down**.
The application chooses its local targets and error cascade; it does not need
to configure upstream URLs or secrets.

Borrow [aisuite](https://github.com/andrewyng/aisuite)'s small client-and-adapter
dispatch idea, but not its OpenAI-shaped-only interface, agent framework,
toolkits, or Python implementation. [Mirascope](https://github.com/Mirascope/mirascope)'s
decorator-based prompt/workflow interface adds concepts this infrastructure
client does not need. Neither project is a required dependency.

## Many-to-many means dialects in both directions

The important many-to-many relationship is **caller dialect to target dialect**.
An application may send OpenAI Chat, OpenAI Responses, or Anthropic Messages;
an eligible target may natively speak any of these dialects. Chat to Messages
and Messages to Chat are both useful. The same applies to each supported pair
of dialects: the SDK returns a response in the **caller's** dialect, not always
an OpenAI-shaped answer. One key may also address many selectors, and a local
plan may offer many target candidates for each selector and caller dialect.

Avoid a separate converter implementation for every pair. For conversational
calls, place a small **assessed common text-turn representation** between
ingress decoders and target encoders, with the reverse path for responses.
Native same-dialect calls preserve their original envelope when possible.
The common representation covers only semantics its adapters can actually
preserve; it is not a universal model for stateful sessions, media, and every
provider feature. An unrepresentable field or stream event is refused before
the local call, never silently dropped. Embeddings and other operations have
separate, smaller mappings rather than being forced through text turns.

The concrete request matters: a dialect pair can support a plain text turn
but refuse that same pair when a request also needs a feature it cannot carry.
An advertised provider or model alone is not proof that a conversion works.
The SDK's compatibility contract states which request features and stream
events each pair preserves.

## SDK interface

- Construct with gateway URL, project key, and optional local cache path.
- Call/stream in the caller's dialect using a model or named endpoint selector.
  Return responses and errors in that dialect; preserve cancellation.
- Supply `localTargets(selector, dialect)` in application code. It returns an
  ordered list of target IDs from the snapshot for that installation. Supply
  `shouldTryNext(error, target)` to decide whether a failed local attempt moves
  to the next candidate. The SDK classifies errors and performs the requested
  cascade; it does not dictate the local order or error policy.
- Optionally supply `isGatewayUnavailable(error)` to recognize a proxy outage
  response. By default, only a connection failure before HTTP dispatch enters
  local mode; a gateway policy refusal or upstream provider error does not.
- Report whether a response came from the gateway or a local target, and name
  the actual target for a local response.

The live gateway selector remains opaque to the SDK. The local plan may differ
from the gateway's own endpoint chain and may differ across installations with
the same project key. The SDK does not administer projects, keys, or providers.

## Key-scoped connection snapshot

Add a versioned, read-only `/v1/client-snapshot` endpoint authenticated by a
gateway-issued project key with offline access enabled. It lists that key's
eligible selector names and target IDs. Each target describes its upstream URL,
provider/model identity, native dialect and surfaces, calling credential, and
any credential expiry. It also describes effective permissions for adapting a
selector to a target: a local client must not enable a conversion that the
gateway would refuse. The gateway describes eligible targets; each installed
SDK determines which ones its qualified adapters can actually execute.

Return only material the active key, project, principal, policy, and credential
ownership permit. A route must not expand key access. Offline access is an
explicit option on a project key; existing inference keys do not gain
credential-export permission. This endpoint is not an export of administrator
state or the public provider catalog.

## Gateway-first calls and lazy cache

1. Try the gateway. If it responds, return its answer or error unless the
   application explicitly recognizes an ingress outage. Gateway authorization,
   quotas, routing, and protocol assessment remain authoritative while online.
   Do not automatically replay ambiguous timeouts or opened streams locally.
2. On each SDK use, check the snapshot's last successful fetch time. If it is
   over one hour old, start at most one nonblocking fetch per client instance.
   Keep the last good snapshot until a complete replacement is validated and
   saved atomically. No polling timer or scheduler is needed.
3. When the gateway is unavailable, resolve the application's local target IDs
   for the requested selector and caller dialect. For each target, check its
   authorization, credential expiry, adaptation permission, native surface,
   and whether the installed adapters can preserve this concrete request and
   response. Invoke it only if those checks pass. Ask `shouldTryNext` after a
   local failure; never splice or replay an already opened stream.
4. If there is no saved snapshot or usable target, return a clear error. A new
   installation needs a successful fetch before local fallback can work.

Snapshot age and credential expiry are separate. The SDK does not renew
upstream credentials; an expired or rejected credential can be passed over if
the application's policy chooses another eligible target. Use one owner-only
local file by default. The file contains upstream credentials; no SQLite
dependency or second application secret is required.

## First-release scope and delivery

The first *complete* conversational compatibility set is the **common
stateless text subset** across three ingress and three target dialects: OpenAI
Chat, OpenAI Responses, and Anthropic Messages. A plain text request and
response should work in each of the nine directed cells, subject to the
gateway's permissions and target capabilities. Native same-dialect requests
can preserve more fields. Plain-text SSE has a bounded event conversion for
each cell. Cross-dialect tools, structured output, reasoning, multimodal
carriers, and their streaming events need separate request/response/event
qualification; until then they fail closed. Publish the supported matrix per
SDK language, not a blanket all-fields claim.
OpenAI-compatible embeddings are a separate native operation. Stateful
Responses, media, and more target dialects can follow later.

1. Define a small versioned snapshot contract and cross-language fixtures for
   the nine text-only cells, native pass-through, incompatible fields, stream
   boundaries, two local candidates, gateway outage, a local error cascade,
   and an expired credential. Use the gateway's documented finite conversion
   behavior as a reference, not an unlimited protocol promise.
2. Add the scoped snapshot and offline-access key option. Prove an ordinary
   key cannot export credentials and that one project's key cannot see another
   project's targets. The server does not implement the SDK's local plan.
3. Build Python first: gateway transport, owner-only file, nonblocking lazy
   fetch, application-supplied plan, three ingress decoders, three target
   encoders, reverse response conversion, and fail-closed assessment. Use lean
   dialect clients for transport; do not depend on aisuite's application stack.
4. Build idiomatic Node.js and Go clients against the same wire/behavior
   fixtures. Reuse the contract and compatibility checks, not Python source or
   an imposed cross-language implementation library.
5. Publish examples using two caller dialects and two different target
   dialects, with installation-specific local order and `shouldTryNext`. Add
   more feature and stream cells only after checking their semantics.

## Honest availability limits

Local calls need network access to the selected upstream. Gateway accounting
and strict quotas do not cover calls made while the gateway is unavailable;
usage reconciliation is a later feature. A previously fetched file cannot
observe key revocation or changed policy until the gateway reconnects. These
limits accompany the SDK's offline-access grant and installation guidance.
