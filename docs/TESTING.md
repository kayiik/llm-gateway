# Local testing

Use the small Node runner from the repository root. It requires Node and the Go
toolchain declared in `go/go.mod`; it installs no dependencies or services.

```text
node scripts/test-local.mjs policy
node scripts/test-local.mjs api --run TestResponses
node scripts/test-local.mjs go --package ./internal/iam --run TestUsage
node scripts/test-local.mjs console
node scripts/test-local.mjs all
```

| Profile | Checks |
| --- | --- |
| `policy` (default) | Focused native/compatible routing, route contracts, body validation, playground parity, transparent responses and stream lifecycle regressions. |
| `api` | The complete API package, or the tests selected with `--run REGEX`. |
| `go` | All Go packages, using the normal `go test` checks. |
| `console` | TypeScript checks and the existing console unit tests. Run `npm ci` in the console directory once when dependencies need installing. |
| `all` | All Go packages, console checks and documentation checks, serially. |

Focused API profiles compile one test executable and reuse it across filters and
`--repeat N` runs. Its cache key covers the selected toolchain, module bindings,
Go's dependency file list, local replacement sources, embedded assets, and
effective architecture/CGO compiler settings. A
source change invalidates the executable; changing the test selection does not.
Focused compilation omits vet; `go`/`all` retain Go's normal vet behavior. The
repository's release checks, including distribution, static analysis and
vulnerability scans, remain the full publication gate.

Each run gets disposable home/config/state paths while preserving the existing
Go module and build caches. Windows roaming/local application-data paths are
isolated too. Live-test switches and GCP/AWS credential-file
references are removed, and HTTP uses the fixture-only proxy policy. The runner never
opens a local deployment configuration. Results, timings and complete logs are
retained in the printed directory; failed exits, timeouts and empty selections
are failures even if a process previously printed `PASS`.

For an explicitly selected cross-repository development binding:

```text
node scripts/test-local.mjs policy --modfile /path/to/local.mod
```

The external modfile selects local libraries without editing the repository's
published pins or adding a workspace. The runner never guesses sibling checkouts.
`--go PATH`, `--artifacts DIRECTORY`, and `--timeout MILLISECONDS` select the
executable, artifact/cache parent and per-command deadline. Defaults can also be
set in the current process with `LLMGW_TEST_GO`, `LLMGW_TEST_MODFILE` and
`LLMGW_TEST_ARTIFACTS`; they do not change installed configuration.

Runner supervision and cache invalidation checks:

```text
node --test scripts/test-local.test.mjs
```
