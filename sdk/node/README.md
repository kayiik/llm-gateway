# Gateway-first JSON client for Node.js

This preview source package supports JSON calls and text-only SSE streaming for
Chat, Responses and Messages, with cross-dialect fallback to key-scoped direct
targets. See [SDK setup and limits](https://github.com/kayiik/llm-gateway/blob/main/sdk/README.md) in the source repository.

Pass the gateway URL, project key, private cache path, `localTargets`, and
`shouldTryNext` to `Client`, then `await client.load()` and
`await client.refresh()` while the gateway is available. Calls use
`client.call(dialect, selector, body)` or `client.stream(dialect, selector, body)`;
the application owns local target order. Iterate `stream.events` and call
`stream.cancel()` when leaving an unfinished stream.
