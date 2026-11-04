# Gateway client SDKs: JSON and text streaming

The source clients under `node/`, `python/`, and `go/` implement bounded JSON
calls and SSE text streaming from the [SDK design](../docs/SDK_DESIGN.md).
They are not published packages. Node.js requires 20+, Python requires 3.10+,
and Go uses its own module under `go/`.

For a local source checkout, install Node.js with `npm install ./sdk/node`
or Python with `python -m pip install ./sdk/python` from the repository root.
The Go package is a nested module at `sdk/go`; its import path becomes
available to other modules after a corresponding module release tag. Package
manifests remain preview/private until that release is chosen.

1. In the administrator console, create a project key and select **Allow offline
   access**. Configure a named route and connect API-key providers with explicit
   upstream URLs. Synchronize each provider's catalog so the gateway knows its
   native Chat, Responses, or Messages surface.
2. Configure the SDK with the gateway URL, the project key, a cache-file path,
   and application code that names local target IDs for each route and caller
   dialect. The target IDs are `provider/model`; URLs and upstream credentials
   arrive in the snapshot, not in application code.
3. Call `refresh()` once while online to prime the local file. Later calls
   check the last successful fetch and refresh nonblockingly when it is over
   one hour old. If the gateway cannot be dialed, the SDK tries targets in
   the application's order; `shouldTryNext` decides whether a local failure
   advances to the next target.

Python: instantiate `llmgw_client.Client(url, key, cache_path, local_targets,
should_try_next)` and call `client.call("chat", "coding", {"messages": [...]})`.
Node.js: `await new Client({ url, key, cachePath, localTargets, shouldTryNext
}).load()`, followed by `await client.refresh()` and
`await client.call("chat", "coding", { messages: [...] })`.
Go: `llmgwclient.New(url, key, cachePath, localTargets)`, then
`client.Refresh(ctx)` and `client.Call(ctx, "chat", "coding", body)`.

Streaming has a separate interface: Python `with client.stream("chat", "coding",
body) as stream: ...` iterates `StreamEvent(event, data)` and closes on exit;
Node.js `const stream = await client.stream("chat", "coding", body)` exposes
`stream.events` as an async iterable and `stream.cancel()`; Go
`client.Stream(ctx, "chat", "coding", body)` returns a stream with `Next()`
(`io.EOF` only after a valid terminal) and `Close()`. Each also reports `source`
and the local target ID. The caller should close/cancel an unfinished stream.
Consume a stream from one reader at a time; Go `Close` can interrupt a blocked
`Next`. Use `call`/`Call` for completed JSON and `stream`/`Stream` for SSE.
Stream opening is bounded, and stalled SSE reads time out after 30 seconds by
default. Set Python `stream_idle_timeout` (seconds), Node.js
`streamIdleTimeoutMs` (milliseconds), or Go `Client.StreamIdleTimeout` to change
the idle bound for long-running models. Python applies its bound to opening as
well; Node.js and Go use a 30-second response-header bound.

For a result with provenance, use Python `call_with_info`, Node.js
`callWithInfo`, or Go `CallWithInfo`: each returns `data`, `source` (`gateway`
or `direct`), and the direct target ID when applicable. Gateway connection
failures enter fallback by default; an application may additionally classify
an ingress proxy's 502/503/504 as an outage with `is_gateway_unavailable`,
`isGatewayUnavailable`, or `IsGatewayUnavailable`. Other gateway responses,
including authentication and policy refusals, remain gateway responses.

All three retain native JSON and native SSE events for same-dialect calls.
Cross-dialect conversions among Chat, Responses, and Messages preserve the
qualified stateless plain-text subset, including incremental text deltas and
successful terminal events. Only text turns and an output-token limit can be
converted; tool/media/opaque events and unqualified targets fail closed rather
than being dropped. A stream opened by a provider is never silently replayed
on another target, even if a later event fails or the source closes early.
Converted Messages SSE uses zero in protocol-required usage placeholders when
upstream counts have not arrived; these are **not measured usage** and should
not be billed. Local event errors are raised, never replaced by a success
terminal.
Local decisions are application-owned. The SDK does not refresh provider
credentials, reconcile offline usage, or enforce gateway quotas while offline.
The saved file contains upstream credentials: keep it private to the runtime
user (configure a private directory/ACL on Windows) and remove it when that
installation should lose offline access. The cache is bound to the exact
gateway URL and project key; reusing its path with a different pair is refused.

Run `npm test` in `node/`, `python -m unittest` in `python/`, and `go test ./...`
in `go/`. A local end-to-end contract check can be run from `../go/` with
`LLMGW_SDK_E2E=1 go test ./internal/api -run TestClientSnapshotHTTPProvidesUsableDirectConnection -count=1`
(set `LLMGW_SDK_E2E=1` in the shell's environment first on Windows). It tests
the real gateway HTTP handler, cached JSON fallback, and converted SSE streams
in all three SDKs against an isolated upstream fixture; no provider account is
needed.
