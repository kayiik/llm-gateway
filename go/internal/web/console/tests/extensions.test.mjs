import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildBox, data, served, workstation } from "./extension-fixtures.mjs";
import { bundle, mount, settle } from "./hook-harness.mjs";

const stubs = [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args); export const sendForm = (...args) => globalThis.__api.sendForm(...args);" },
];
const ext = await bundle(fileURLToPath(new URL("../src/components/providers/extensions.ts", import.meta.url)), stubs);

test("an extension's pill says whether it answers, how fast, or what went wrong", () => {
  assert.deepEqual(ext.extensionPill(workstation.status), { label: "Reachable · 14 ms", tone: "ready" });
  assert.deepEqual(ext.extensionPill({ ...workstation.status, version: "0.0.1" }), { label: "Reachable · 14 ms", tone: "ready" }, "an implementation version is not a protocol version");
  assert.deepEqual(ext.extensionPill(buildBox.status), { label: "No answer", tone: "attention" });
  assert.deepEqual(ext.extensionPill({ probed: true, error_code: "secret_refused" }), { label: "Secret refused", tone: "attention" });
  assert.deepEqual(ext.extensionPill({ probed: true, error_code: "not_an_extension" }), { label: "Not a companion daemon", tone: "attention" });
  assert.deepEqual(ext.extensionPill({ probed: true, error_code: "error" }), { label: "Error", tone: "attention" });
  // A secret that no longer decrypts is never sent, so nothing probed it.
  assert.deepEqual(ext.extensionPill({ probed: false, error_code: "error" }), { label: "Error", tone: "attention" });
  assert.deepEqual(ext.extensionPill({ probed: false, error_code: "" }), { label: "Not checked", tone: "muted" });
  assert.deepEqual(ext.extensionPill(undefined), { label: "Not checked", tone: "muted" });
});

test("a row counts what the daemon serves, which only an answer says, and what uses it", () => {
  assert.equal(ext.servedSummary(workstation), "Serves 6 providers · 3 in use");
  assert.equal(ext.servedSummary({ ...workstation, providers: [] }), "Serves 6 providers · none in use");
  assert.equal(ext.servedSummary({ ...buildBox, providers: [{ id: "copilot", type: "github_copilot" }] }), "1 provider in use");
  assert.equal(ext.servedSummary(buildBox), "No providers in use");
  assert.equal(ext.answeredIn(workstation.status), "14 ms");
  assert.equal(ext.answeredIn({ probed: true, error_code: "secret_refused", latency_ms: 3 }), "3 ms");
  assert.equal(ext.answeredIn(buildBox.status), "No answer");
  assert.equal(ext.answeredIn({ probed: false, error_code: "error" }), "Not checked");
});

test("surfaces and sign-in methods read as an administrator names them", () => {
  assert.deepEqual(["chat_completions", "responses", "messages", "audio_speech", "audio_transcriptions", "embeddings"].map(ext.surfaceLabel), ["Chat", "Responses", "Messages", "Speech", "Audio transcriptions", "Embeddings"]);
  assert.equal(ext.signInLabel("oauth", ["device"]), "Device code");
  assert.equal(ext.signInLabel("oauth", ["browser"]), "Browser");
  assert.equal(ext.signInLabel("oauth", ["manual"]), "Paste a code");
  assert.equal(ext.signInLabel("oauth", ["browser", "device"]), "Browser or device code");
  assert.equal(ext.signInLabel("oauth", []), "Account sign-in");
  assert.equal(ext.signInLabel("token", []), "Paste a token");
  assert.equal(ext.signInLabel("none", []), "None needed");
  assert.equal(ext.signInLabel("", []), "Not reported");
});

test("a served provider's state comes from its instances in this gateway", () => {
  assert.deepEqual(ext.servedState("oauth", []), { label: "Not added", tone: "muted", added: false, needs: "" });
  assert.deepEqual(ext.servedState("oauth", [{ status: "catalog_synced", connection_count: 2 }]), { label: "2 accounts · catalog synced", tone: "ready", added: true, needs: "" });
  assert.deepEqual(ext.servedState("oauth", [{ status: "configured", connection_count: 1 }]), { label: "1 account · unverified", tone: "muted", added: true, needs: "" });
  assert.deepEqual(ext.servedState("oauth", [{ status: "check_failed", connection_count: 1 }]), { label: "1 account · check failed", tone: "attention", added: true, needs: "" });
  assert.deepEqual(ext.servedState("oauth", [{ status: "needs_credentials", connection_count: 0 }]), { label: "Added · needs an account", tone: "attention", added: true, needs: "account" });
  assert.deepEqual(ext.servedState("oauth", [{ status: "verified", connection_count: 1 }, { status: "catalog_synced", connection_count: 2 }]), { label: "3 accounts · all instances ready", tone: "ready", added: true, needs: "" });
  assert.deepEqual(ext.servedState("token", [{ status: "needs_credentials" }]), { label: "Added · needs a token", tone: "attention", added: true, needs: "token" });
  assert.deepEqual(ext.servedState("token", [{ status: "verified" }]), { label: "Verified", tone: "ready", added: true, needs: "" });
  assert.deepEqual(ext.servedState("none", [{ status: "configured" }]), { label: "Configured · unverified", tone: "muted", added: true, needs: "" });
  assert.deepEqual(ext.servedState("none", [{ status: "needs_credentials" }]), { label: "Configured · unverified", tone: "muted", added: true, needs: "" }, "discovery of a no-credential provider supersedes an older generic status");
  assert.deepEqual(ext.servedState("none", [{ status: "disabled" }]), { label: "Disabled", tone: "muted", added: true, needs: "" });
  assert.deepEqual(ext.servedState("none", [{ status: "configured" }], true), { label: "Not served by this daemon", tone: "attention", added: true, needs: "" });
});

test("the providers a daemon serves are joined with the configured ones it serves", () => {
  const rows = ext.servedRows(workstation, data);
  assert.deepEqual(rows.map((row) => [row.label, row.surfaces.map(ext.surfaceLabel).join(" "), row.signIn, row.state.label]), [
    ["GitHub Copilot", "Chat Responses", "Device code", "2 accounts · catalog synced"],
    ["OpenAI Codex", "Chat Responses", "Browser or device code", "Not added"],
    ["Google Antigravity", "Chat", "Paste a code", "Not added"],
    ["Edge TTS", "Speech", "None needed", "Configured · unverified"],
    ["OpenCode Zen, anonymous", "Chat Responses", "None needed", "Not added"],
    ["Anthropic, setup token", "Messages", "Paste a token", "Added · needs a token"],
  ]);
  assert.deepEqual(rows[0].instances.map((instance) => instance.id), ["copilot"]);
  assert.equal(rows[0].registryID, "");
  assert.equal(rows[5].registryID, "");
  assert.equal(rows[5].markID, "anthropic_setup_token");
  assert.ok(rows.every((row) => row.addable && !row.unserved));

  // A daemon that did not answer is represented by the providers configured
  // to use it, as far as the gateway knows them.
  const silent = ext.servedRows({ ...workstation, status: buildBox.status }, data);
  assert.deepEqual(silent.map((row) => [row.label, row.surfaces.join(" "), row.signIn]), [
    ["github_copilot", "", "Not reported"],
    ["edge_tts", "", "Not reported"],
    ["anthropic_setup_token", "", "Not reported"],
  ]);

  // A daemon that does not serve a configured provider's type says so.
  const older = ext.servedRows({ ...workstation, status: { ...workstation.status, served: served.slice(0, 4) } }, data);
  assert.deepEqual(older.at(-1).state, { label: "Not served by this daemon", tone: "attention", added: true, needs: "" });
  assert.equal(older.at(-1).unserved, true);
  // A conforming declaration is addable without a console type registration.
  const newer = ext.servedRows({ ...workstation, providers: [], status: { ...workstation.status, served: [{ id: "example_new", name: "Example new", surfaces: ["images"], credential: "none" }] } }, data);
  assert.deepEqual(newer.map((row) => [row.label, row.addable]), [["Example new", true]]);
  const empty = ext.servedRows({ ...workstation, status: { ...workstation.status, served: [] } }, data);
  assert.ok(empty.every((row) => row.unserved), "an empty successful discovery does not retain old capability claims");
});

test("the hub's search and filter reach the providers inside an extension", () => {
  const extensions = [workstation, buildBox];
  assert.deepEqual(ext.shelfItems(extensions, data, "", "all").map((item) => [item.extension.id, item.rows.length, item.matched]), [["workstation", 6, false], ["build-box", 0, false]]);
  assert.deepEqual(ext.shelfItems(extensions, data, "copilot", "all").map((item) => [item.extension.id, item.rows.map((row) => row.type), item.matched]), [["workstation", ["github_copilot"], true]]);
  // An instance ID finds its provider too.
  assert.deepEqual(ext.shelfItems(extensions, data, "claude-max", "all").map((item) => item.rows.map((row) => row.type)), [["anthropic_setup_token"]]);
  // A search for an extension shows it whole.
  assert.deepEqual(ext.shelfItems(extensions, data, "build", "all").map((item) => [item.extension.id, item.matched]), [["build-box", false]]);
  assert.deepEqual(ext.shelfItems(extensions, data, "", "official")[0].rows.map((row) => row.type), ["github_copilot", "openai_codex", "google_antigravity"]);
  assert.deepEqual(ext.shelfItems(extensions, data, "", "configured")[0].rows.map((row) => row.type), ["github_copilot", "edge_tts", "anthropic_setup_token"]);
  assert.deepEqual(ext.shelfItems(extensions, data, "", "no-key")[0].rows.map((row) => row.type), ["edge_tts", "opencode_zen_anonymous"]);
  assert.deepEqual(ext.shelfItems(extensions, data, "ollama", "all"), []);
  const state = (extensions, listing = { extensions }) => ({ listing, extensions });
  assert.equal(ext.shelfShows(state([], null), data, "ollama", "local"), true, "a listing still loading shows that");
  assert.equal(ext.shelfShows(state([]), data, "", "all"), true);
  assert.equal(ext.shelfShows(state([]), data, "copilot", "all"), false, "an unknown extension does not advertise providers");
  assert.equal(ext.shelfShows(state([]), data, "extensions", "all"), true);
  assert.equal(ext.shelfShows(state([]), data, "ollama", "all"), false);
  assert.equal(ext.shelfShows(state([]), data, "", "local"), false);
  assert.equal(ext.shelfShows(state(extensions), data, "copilot", "all"), true);
  assert.equal(ext.shelfShows(state(extensions), data, "ollama", "all"), false);
});

test("adding a served provider never replaces one configured elsewhere", () => {
  assert.equal(ext.freeProviderID("copilot", []), "copilot");
  assert.equal(ext.freeProviderID("copilot", ["copilot", "copilot-2"]), "copilot-3");
  const [copilot, , , , zen] = ext.servedRows(workstation, data);
  assert.equal(ext.providerBaseID(copilot), "github_copilot");
  assert.equal(ext.providerBaseID(zen), "opencode_zen_anonymous");
  assert.deepEqual(ext.addProviderBody(copilot, "workstation", "copilot-2"), { type: "github_copilot", id: "copilot-2", extension: "workstation" });
  assert.deepEqual(ext.addProviderBody(zen, "workstation", "opencode-zen-anonymous"), { id: "opencode-zen-anonymous", type: "opencode_zen_anonymous", extension: "workstation" });
});

test("a failed check names the problem and the way out", () => {
  assert.deepEqual(ext.checkFailure({ error_code: "secret_refused", error: "the extension refused the secret (HTTP 401)" }, "http://127.0.0.1:18888"),
    { tone: "error", title: "The daemon refused this secret", detail: "Enter the shared secret configured on this extension." });
  const silent = ext.checkFailure(buildBox.status, "http://127.0.0.1:18888");
  assert.equal(silent.title, "Nothing answered at http://127.0.0.1:18888");
  assert.match(silent.detail, /^Check that the daemon is running and listens at this address\. If the gateway runs in a container, 127\.0\.0\.1 is the container itself/);
  assert.equal(silent.reported, "the extension did not answer within 5s");
  assert.doesNotMatch(ext.checkFailure(buildBox.status, "http://extension:18888").detail, /container/, "a service name needs no container hint");
  assert.match(ext.checkFailure(buildBox.status, "http://localhost:18888").detail, /container/);
  assert.equal(ext.checkFailure({ error_code: "not_an_extension" }, "http://127.0.0.1:8080").title, "That isn't a companion daemon");
  assert.deepEqual(ext.checkFailure({ error_code: "error", error: "the extension answered HTTP 500" }, "http://127.0.0.1:18888"),
    { tone: "error", title: "The check failed", detail: "Check the address and the secret, then check again.", reported: "the extension answered HTTP 500" });
  assert.match(ext.unauthenticatedWarning.detail, /Configure the extension to require its shared secret\.$/);
});

test("an extension that cannot be used says which providers it leaves without a daemon", () => {
  assert.equal(ext.unreachableEffect(workstation), null);
  assert.equal(ext.unreachableEffect(buildBox), null, "nothing depends on it");
  const effect = ext.unreachableEffect({ ...workstation, providers: [...workstation.providers, { id: "codex", type: "openai_codex", disabled: true }], status: buildBox.status });
  assert.deepEqual(effect.providers, ["copilot", "edge_tts", "claude-max"], "a disabled provider serves nothing anyway");
  assert.equal(effect.detail, "Routes skip them and try their next member; a request only they can serve fails. Start the daemon, or change the address.");
  assert.match(ext.unreachableEffect({ ...workstation, providers: [{ id: "copilot", type: "github_copilot" }], status: { probed: true, error_code: "secret_refused" } }).detail, /^Routes skip it .* only it can serve fails\. Enter the secret the daemon was started with\.$/);
  assert.equal(ext.unreachableEffect({ ...workstation, status: { probed: false, error_code: "" } }), null, "nothing checked it yet");
});

test("an extension in use says what keeps it, and a refused save says why", () => {
  assert.equal(ext.removalReason([]), "");
  assert.equal(ext.removalReason(["copilot"]), "Provider copilot uses this extension. Remove it, or name another extension for it, first.");
  assert.equal(ext.removalReason(["copilot", "edge_tts", "claude-max"]), "Providers copilot, edge_tts and claude-max use this extension. Remove them, or name another extension for them, first.");
  const keyless = ext.storeRefusal("LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to store an extension's secret, which the gateway never stores in plaintext");
  assert.deepEqual([keyless.tone, keyless.title], ["warning", "The secret can't be stored yet"]);
  assert.match(keyless.detail, /then add the extension\.$/);
  assert.match(ext.storeRefusal("LLMGW_CREDENTIAL_ENCRYPTION_KEY is required", true).detail, /then save the new secret\.$/);
  assert.equal(ext.storeRefusal('extension "home" already exists; choose another id').title, "That name is taken");
  assert.deepEqual(ext.storeRefusal("the url must be an absolute http or https URL"), { tone: "error", title: "The extension wasn't added", detail: "the url must be an absolute http or https URL" });
});

test("the listing loads with the state and a check replaces one extension's status", async () => {
  const requests = [];
  globalThis.__api = { getJSON: async (mode, path) => { requests.push([mode, path]); return { extensions: [workstation, buildBox], minimum_version: "0.0.4", legacy_environment: true }; } };
  let state = data;
  const render = mount(() => ext.useExtensions(true, state));
  render();
  await settle();
  let extensions = render();
  assert.deepEqual(requests, [["admin", "/extensions"]]);
  assert.deepEqual(extensions.extensions.map((extension) => extension.id), ["workstation", "build-box"]);
  assert.equal(extensions.minimumVersion, "0.0.4");
  assert.equal(extensions.legacyEnvironment, true);
  assert.equal(extensions.loading, false);
  extensions.setStatus("build-box", workstation.status);
  extensions = render();
  assert.equal(extensions.extensions[1].status.reachable, true);
  assert.equal(extensions.extensions[0].status, workstation.status);
  // The state reloads after every change, and the listing with it.
  state = { ...data };
  render();
  await settle();
  assert.equal(requests.length, 2);
  // A portal asks nothing.
  const portalRequests = requests.length;
  const portal = mount(() => ext.useExtensions(false, data));
  portal();
  await settle();
  assert.equal(requests.length, portalRequests);
  assert.equal(portal().loading, false);
});
