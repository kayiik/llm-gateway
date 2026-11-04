# Gateway-first JSON client for Python

This preview source package supports JSON calls and text-only SSE streaming for
Chat, Responses and Messages, with cross-dialect fallback to key-scoped direct
targets. See [SDK setup and limits](https://github.com/kayiik/llm-gateway/blob/main/sdk/README.md) in the source repository.

Pass the gateway URL, project key, private cache path, `local_targets`, and
`should_try_next` to `Client`, then call `refresh()` while the gateway is
available. Calls use `call(dialect, selector, body)`; the application owns
local target order. Use `with client.stream(dialect, selector, body) as stream:`
to iterate events and close an unfinished stream.
