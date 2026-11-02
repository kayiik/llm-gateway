# Mocked integration stack

This local Docker stack runs the gateway against WireMock fixtures. It proves
deterministic endpoint routing without a real provider credential. It is not
real-provider UAT.

| Service | Role |
| --- | --- |
| `gateway` | Current `go/Dockerfile` worktree build |
| `wiremock` | In-network mocked provider responses |
| `edge` | Loopback-only host bridge at `127.0.0.1:8887` |

The gateway and WireMock share an internal network. The edge container also joins
a bridge used only to publish its loopback port, so the entire stack is not
network-isolated. Provider base URLs point only at WireMock.

## Run

```bash
cp test/integration/.env.test.example test/integration/.env.test

LLMGW_UAT_TAG="$(git rev-parse --short HEAD)" \
LLMGW_BUILD_COMMIT="$(git rev-parse HEAD)" \
LLMGW_BUILD_TIME="$(git show -s --format=%cI HEAD)" \
docker compose -f test/integration/docker-compose.test.yml \
  --env-file test/integration/.env.test \
  --project-name llmgw-int \
  up --build --wait
```

For attributable release evidence, require a clean worktree first:

```bash
git diff --quiet && git diff --cached --quiet
```

The Dockerfile rebuilds the console from source. A dirty worktree is tested but
cannot be identified by the commit alone.

## Verify

```bash
curl -fsS http://127.0.0.1:8887/health
curl -fsS \
  -H 'Authorization: Bearer replace-with-a-local-uat-key' \
  http://127.0.0.1:8887/v1/models
```

Use the repository's automated API/integration tests for assertions. The stack
itself does not contain a browser journey harness or SSO-header injector.

| Fixture endpoint | Expected behavior |
| --- | --- |
| `cat-429-failover` | Primary `429`, fallback returns `200` |
| `cat-5xx-failover` | Primary `500`, fallback returns `200` |
| `cat-timeout-failover` | First target exceeds its timeout, fallback returns `200` |
| `cat-direct-fallback` | One successful target |
| `cat-priority-chain` | `429`, then `500`, then successful target |

The `cat-` names are legacy fixture identifiers; product terminology is
**endpoint**.

## Shared protocol fixture

`fake-upstream.mjs` and `fixtures/conversation.json` provide one no-credential
Chat, Messages and Responses tool conversation for backend HTTP and console tests.
The hand-built fixtures cover protocol shapes; they do not certify a vendor or
represent a stored private conversation. The same server supports delayed replies,
throttling, paced stream frames and interrupted streams through its exported
`createFakeUpstream` options.
Chat tool/continuation and stream shapes were checked against bounded native
OpenRouter interactions. Messages/Responses fixtures exercise the owned conversion
contracts; they are not live native-vendor recordings. Optional plain reasoning
annotations exercise explicit advisory-loss handling, not preservation of thinking.

Run it directly with `node test/integration/fake-upstream.mjs --port=18889`.
It listens only on loopback; `/chat/v1`, `/messages/v1` and `/responses/v1` are
provider base URLs. `GET /metrics` exposes fixture-only request/cancellation counts.
The automated `TestSharedUpstreamPublicToolConversations` test uses a temporary
port and checks all nine native/conversion streaming tool combinations through
Gateway HTTP, including explicit refusal of unsupported strict-tool conversion.
It needs Node.js; without Node it is explicitly skipped. Console
tests use the same contract and server alongside their Gateway-event UI assertions.

## Recorded traffic through a running Gateway

```bash
node test/integration/run-recorded-http.mjs --image=<already-built-gateway-image>
```

This runs the real Gateway binary in Docker and sends ordinary public HTTP
requests. The provider uses controlled recorded and synthetic fixtures. Containers
share a new internal-only network; no ports, saved credentials or existing state
are used. The default `replay` profile keeps Gateway state in temporary memory.
The Gateway image and `node:22-alpine` must already exist locally; the
runner never pulls them. JSON results, request/response bodies, telemetry, image
identities and both process logs go to a fresh temporary artifact directory. Pass
`--artifacts=<new-directory>` to choose its location.

The `recorded-groq-chat.*` and `recorded-codex-responses.sse` fixtures retain
sanitized native Gateway-observed bodies/events, including optional fields and
source usage. They do not contain original upstream request headers or credentials.
Fake provider request expectations reconstruct the protocol contract; they are
not presented as upstream request captures. Responses events are replayed through
an OpenAI-compatible fixture provider; this is Gateway Responses HTTP coverage,
not a second claim of Codex authentication/adapter qualification.

Assertions cover authentication, caller model scope, native-only policy, exact
native responses/usage, actual two-turn tool association, native streaming, named
routes, partial-stream fallback refusal, missing terminal detection and Gateway
request telemetry. The provider stub rejects wrong tool IDs without consuming the
valid next record. Partial and missing-terminal streams are explicit fault injections into
the recorded payloads. `--cases=<comma-separated-case-names>` reruns only affected
cases while retaining the earlier artifact directory.

`translated-messages-stream-usage-http` exercises allowed Messages ingress through
the real prepared Chat conversion. The stub requires the generated
`stream_options.include_usage` control; the translated terminal event must carry
the nonzero input and output counts from `synthetic-chat-usage.sse`.
The control expectation is reconstructed, and the retained recordings remain unchanged.

`streaming-tool-conversation-matrix` uses the shared synthetic conversation for
every Chat/Responses/Messages ingress/upstream pair, both by direct selector and
named route. Sixteen supported combinations carry the actual returned tool call
into a second request and preserve final text and exact input/output usage. The
two Responses-to-Messages strict-tool combinations must refuse before dispatch.
The matrix requires exactly 32 upstream calls in total, verifies both encoded
requests at the selected upstream, and rejects wrong tool associations without
advancing a conversation. Named routes use their configured adaptation policy
without a request-header override. `streaming-tool-matrix.json` records every
combination and its outcome separately.

`gateway-request-telemetry` is independently selectable. It correlates successful
tools/continuation/streaming, interrupted streams and a policy refusal to individual
request IDs. It checks caller/project/key/target, status, bounded timing, source
attempt selection and reported-versus-absent token evidence against the recordings.
It does not certify every billing, audit or retention operation.

`recorded-transcription-multipart-http` reuses the synthetic `Hello.` MP3 and a
sanitized successful transcription response. It verifies multipart fields, the
resolved model and exact audio bytes through the running Gateway; changed audio
must be rejected by the stub. The upstream multipart expectation is reconstructed:
the Gateway rebuilds file parts as `application/octet-stream`. The original client
upload used `audio/mpeg`; neither description is an original provider HTTP capture.

`recorded-native-responses-tool-conversation-http` replays the two recorded native
Responses tool turns. It appends the actual first response items and matching call
result, compares all recorded events and final answer, and checks non-consuming
wrong-call rejection at the stub. A synthetic private human connection is created
through admin HTTP: an admin-key continuation must still fail the real private
connection gate before dispatch. No real OAuth grant or provider secret is used.
The fixture's encrypted reasoning carrier is an explicitly synthetic placeholder;
the test checks preservation, not cryptographic validity.

### Seeded install and upgrade profiles

```text
node test/integration/run-recorded-http.mjs --image=<local-candidate-image> --profile=fresh
node test/integration/run-recorded-http.mjs --image=<local-candidate-image> --profile=upgrade --baseline-image=<local-earlier-image>
```

`fresh` creates an isolated named state volume, seeds it through admin HTTP, stops
the process and starts another instance of the same image against that state.
`upgrade` instead seeds the actual earlier image, stops it, seals a complete
pre-upgrade state snapshot and restores it into a second disposable volume for
the candidate. The two inspected image IDs must differ; a tag alias or same-image
restart cannot stand in for an upgrade. The original snapshot's bytes and state
metadata are checked again after candidate execution.

Both profiles run the same selected recorded HTTP cases, then restart the
candidate. First-start and restart assertions compare seeded identities,
memberships, routes, policies, connections, recoverable/disabled keys, exact quota
counters and old request rows. Real inference through the local fixture proves
that the original private human and service system credentials remain usable
without substituting for one another. Installed CLI/health/admin build identity
and the embedded console's local asset delivery are recorded too. HTTP shell
delivery does not replace browser interaction acceptance.

`bare-alias-two-turn-recording` additionally uses caller-scoped discovery and an
actual two-turn tool exchange through a unique bare model alias.
`legacy-completions-boundary-http` pairs a no-inference `/v1/completions` 404 with
an actual recorded Chat response from bare `/completions`. These are focused
cases; they do not cover every alias collision or bare operation path.

The runner removes its own containers, networks and state volumes on
success or failure. It keeps the artifact directory and upgrade snapshot. These
contain generated test tokens, synthetic credential state and a temporary
credential key: treat the directory as private and keep it outside version control.
The default is outside the repository; an explicit in-repository artifact path must
be ignored, such as a fresh subdirectory under `test/uat-output/`.
No existing installation, volume, credential file or provider account is used.

The sealed stopped-volume snapshot is the harness's copy/restore mechanism. The
upgrade profile separately invokes the earlier installed CLI's backup command,
then checks candidate inspection, explicit-force restore into an empty copy and
the restored seeded HTTP invariants. Corrupt and correctly checksummed newer-schema
archives must fail without adding destination files. A separate original-snapshot
copy also starts and restarts on the exact earlier image and original encryption
key, preserving state and CLI identity. Another restored snapshot copy re-encrypts
seeded API keys, private connections and extension secrets under a generated new
key. It refuses rekey while that Gateway holds the state, refuses startup with
the old key, and starts again with the new key while identities, counters and
decryption remain intact. Neither key nor the mutated copy touches the original
baseline. These do not cover every migration schema
or qualify the intended workspace build merely because another image passed.
Runtime receipts preserve actual image IDs and build observations; the static
scenario mapping remains `not_run`.

### Real installed administrator browser

```text
node test/integration/run-recorded-http.mjs --image=<local-candidate-image> --profile=fresh --browser
node test/integration/run-recorded-http.mjs --image=<local-candidate-image> --profile=upgrade --baseline-image=<local-earlier-image> --browser
```

This optional stage uses an already installed `playwright`/`playwright-core`, or
the existing global `@playwright/cli` runtime, and local Chrome. Nothing is installed
or downloaded. `LLMGW_BROWSER_CHANNEL` can select another already installed
Playwright browser channel. It is available only on seeded fresh/upgrade profiles.

Only a fixed-Gateway ingress proxy joins an additional host-access network and
publishes an ephemeral `127.0.0.1` port. Gateway and its provider remain on the
internal-only network. A new browser context blocks service workers and every
request outside that one Gateway origin. It verifies invalid/valid administrator
sign-in, session-only key storage, new-tab isolation and unauthenticated API refusal,
preserved provider/detail/route/access/key metadata, no implicit key reveal,
390px navigation/Escape/overflow, persisted theme and authenticated reload, then
sign-out and renewed API refusal. The same journeys run again after restart.
Any page error, server error or attempted outside-origin request fails the stage.

The artifacts include redacted per-phase JSON, desktop/mobile screenshots and
masked/redacted failure context. These administrator checks do not replace owner,
mutation, tool-continuation or full accessibility journeys. CLI archive restore and
earlier-image rollback retain their separate installed HTTP checks.

Owner and real-client stages can be included in both seeded profiles:

```text
--browser --owner-browser --browser-runtime=<private-pinned-browser-runtime> --clients --client-runtime=<private-pinned-client-runtime>
```

The owner browser pins its loopback TLS certificate, completes a selected-owner
device sign-in and expired-code retry through a controlled daemon, and audits
its rendered pages. The SDK/CLI stage runs real client processes with a disposable
project key against internal-only native providers. Its optional BYOK runtimes
live outside the repository; the GitHub, Codex and SDK clients receive no real
credential. Aborting an SDK response closes the proxy's upstream stream, and
the revoked disposable key is refused on reuse. The client stage does not contact
or qualify paid providers.

`--shutdown` uses the same disposable Gateway after its HTTP suite: one real
opened fixture stream drains after SIGTERM while new connections refuse, then
a second held stream is cut off by a second signal. The runner restarts the
container before preserved-state checks; no existing installation is signaled.
For the separate process-local ceiling, use
`--caller-rate-limit=2 --cases=process-local-caller-ceiling-and-bounded-retry-after`
on both seeded profiles. This checks two admissions, the third request's bounded
Retry-After, and same-minute reset after restart while project usage persists.
The installed discovery case cancels a held initial alias catalog; after the
Gateway stops, only its disposable service-project catalog is aged. The next
restart serves stale aliases without waiting for the held source and coalesces
the background refresh into one call. No protected baseline is modified.
The full suite also runs controlled compatible-host Chat JSON/SSE cases and a
resource-shaped Azure case. Azure uses distinct internal hostnames, a deployment
catalog pinned to its supported API version, `api-key` instead of bearer,
chat-only deployment filtering and an exact deployment selector. A cross-resource
HTTP redirect must fail without visiting the other host; these assertions do not
grant Azure or any other vendor entitlement. Each matrix saves its own named
case results in the artifact directory for independent failure diagnosis.
The local Ollama matrix serves `/api/tags` and `/api/chat`: without explicit
compatibility permission, Chat and Messages refuse before source I/O; an allowed
request checks adapted JSON/SSE, tool identity and measured daemon usage.
Additional controlled cases keep Google-compatible bearer Chat distinct from
AI Studio's metadata and `generateContent`, refuse key-only Vertex publisher
discovery, assert native ElevenLabs/MiMo and configured OVH-compatible audio,
and fence a held catalog after a project policy revision. Browser runs assert
that a first delta reached the client before an explicit source cutoff and
remains visibly incomplete; keyboard Tab reaches the overflowing raw response
after real inference. The former same-context sign-out race is exercised with
one intercepted 401 and a late state response without using an external IdP.

To check the harness itself, set `LLMGW_TEST_GATEWAY_IMAGE` to a local candidate
and `LLMGW_TEST_BASELINE_IMAGE` to a distinct local earlier image, then run:

```text
node --test test/integration/run-recorded-http.test.mjs
```

The Docker tests explicitly skip when their image variables are absent. The Node
fixture image defaults to local `node:22-alpine`; override it with
`LLMGW_TEST_NODE_IMAGE`. The harness tests also reject an identical-image upgrade
before creating state and reject a modified snapshot before restoring it.
Set `LLMGW_TEST_BROWSER=1` to include the real browser stage in both seeded-profile
control tests; a skipped image test is never browser evidence.

## Tear down

```bash
docker compose -f test/integration/docker-compose.test.yml \
  --env-file test/integration/.env.test \
  --project-name llmgw-int down -v
```
