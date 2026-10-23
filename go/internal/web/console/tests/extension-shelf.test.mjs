import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildBox, data, registry, served, workstation } from "./extension-fixtures.mjs";
import { bundle, find, findAll, input, mount, settle, text } from "./hook-harness.mjs";

const stubs = [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args); export const sendForm = (...args) => globalThis.__api.sendForm(...args);" },
  { filter: /\/useDialogFocus$/, contents: "export const useDialogFocus = () => ({ current: null });" },
];
const shelf = await bundle(fileURLToPath(new URL("../src/components/providers/ExtensionShelf.tsx", import.meta.url)), stubs);
const ext = await bundle(fileURLToPath(new URL("../src/components/providers/extensions.ts", import.meta.url)), stubs);
const { ProviderHub } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderHub.tsx", import.meta.url)), stubs);

// api records every request the console sends and answers it with answer.
function api(answer = () => ({})) {
  const sent = [];
  globalThis.window = { confirm: () => true };
  globalThis.__api = {
    getJSON: async (mode, path) => { sent.push(["GET", path]); return answer("GET", path); },
    sendJSON: async (mode, path, method, body) => { sent.push([method, path, body]); return answer(method, path, body); },
    sendForm: async () => ({}),
  };
  return sent;
}

// listed is the Extensions state the hub hands the shelf.
function listed(extensions, overrides = {}) {
  const calls = [];
  return {
    calls,
    state: {
      listing: { extensions, minimum_version: "0.0.4", legacy_environment: false }, extensions, minimumVersion: "0.0.4", legacyEnvironment: false,
      loading: false, error: "", reload: async () => { calls.push(["reload"]); }, setStatus: (id, status) => calls.push(["setStatus", id, status]),
      ...overrides,
    },
  };
}

function mountShelf(extensions, { search = "", filter = "all", state, stateData = data } = {}) {
  const view = { search, filter, added: [], opened: [], changed: 0 };
  const shelfState = state ?? listed(extensions).state;
  const render = mount(() => shelf.ExtensionShelf({
    data: stateData, extensions: shelfState, search: view.search, filter: view.filter,
    onChanged: async () => { view.changed += 1; },
    onAddAccount: (entry, providerID) => view.added.push([entry.id, providerID]),
    onOpenDetail: (entryID) => view.opened.push(entryID),
  }));
  return { render, view, state: shelfState };
}
const trigger = (tree, id) => find(tree, (node) => node.props?.["data-extension-trigger"] === id);
const buttonIn = (tree, label) => find(tree, (node) => node.type === "button" && text(node).trim() === label);
const rowsOf = (tree) => findAll(find(tree, (node) => node.type === "tbody"), (node) => node.type === "tr");
const rowFor = (tree, label) => rowsOf(tree).find((row) => text(row).startsWith(label));
const notices = (tree) => findAll(tree, (node) => node.props?.message).map((node) => node.props.message.title);

test("each extension's row says what its daemon serves and whether it answers", () => {
  api();
  const tree = mountShelf([workstation, buildBox]).render();
  assert.equal(text(find(tree, (node) => node.type === "header")), "Extensions2Companion daemons that serve providers the gateway can't reach on its own.");
  const home = trigger(tree, "workstation");
  assert.equal(home.props["aria-expanded"], false);
  assert.equal(home.props["aria-controls"], "extension-panel-workstation");
  assert.equal(text(home), "Workstationhttp://127.0.0.1:18888Serves 6 providers · 3 in use0.0.4Reachable · 14 ms");
  assert.equal(find(home, (node) => node.type === "span" && node.props.class?.startsWith("status-pill")).props.class, "status-pill status-pill--ready");
  assert.equal(text(trigger(tree, "build-box")), "Build boxhttp://extension:18888No providers in use—No answer");
  assert.equal(text(trigger(tree, "add")), "Add extension");
  assert.equal(find(tree, (node) => node.type === "article"), undefined, "nothing is open yet");
});

test("an open extension shows its facts, the providers it serves and what each needs", () => {
  api();
  const { render, view } = mountShelf([workstation, buildBox]);
  trigger(render(), "workstation").props.onClick();
  const tree = render();
  assert.equal(trigger(tree, "workstation").props["aria-expanded"], true);
  const panel = find(tree, (node) => node.type === "article");
  assert.equal(panel.props.id, "extension-panel-workstation");
  const facts = findAll(find(panel, (node) => node.type === "dl"), (node) => node.type === "div").map(text);
  assert.deepEqual(facts.slice(0, 4), ["Addresshttp://127.0.0.1:18888", "Shared secretSet · stored encrypted", "Version0.0.4", "Answered in14 ms"]);
  assert.match(facts[4], /^Last checked/);
  assert.deepEqual(rowsOf(tree).map((row) => findAll(row, (node) => node.type === "td").slice(1, 4).map(text)), [
    ["ChatResponses", "Device code", "2 accounts · catalog synced"],
    ["ChatResponses", "Browser or device code", "Not added"],
    ["Chat", "Paste a code", "Not added"],
    ["Speech", "None needed", "Configured · unverified"],
    ["ChatResponses", "None needed", "Not added"],
    ["Messages", "Paste a token", "Added · needs a token"],
  ]);
  const actions = (label) => findAll(rowFor(tree, label), (node) => node.type === "button").map((button) => text(button).trim());
  assert.deepEqual(actions("GitHub Copilot"), ["Add account", "Details"]);
  assert.deepEqual(actions("OpenAI Codex"), ["Add"]);
  assert.deepEqual(actions("Edge TTS"), ["Details"]);
  assert.deepEqual(actions("Anthropic, setup token"), ["Add token", "Details"]);
  assert.equal(buttonIn(tree, "Remove").props.disabled, true);
  assert.equal(find(tree, (node) => node.props?.reason !== undefined).props.reason, "Providers copilot, edge_tts and claude-max use this extension. Remove them, or name another extension for them, first.");
  // The next steps act on the instance the extension serves.
  find(rowFor(tree, "GitHub Copilot"), (node) => node.type === "button" && text(node).includes("Add account")).props.onClick();
  find(rowFor(tree, "Anthropic, setup token"), (node) => node.type === "button" && text(node) === "Details").props.onClick();
  find(rowFor(tree, "GitHub Copilot"), (node) => node.type === "button" && text(node) === "Details").props.onClick();
  assert.deepEqual(view.added, [["github_copilot", "copilot"]]);
  assert.deepEqual(view.opened, ["claude-max", "copilot"]);
  find(rowFor(tree, "Anthropic, setup token"), (node) => node.type === "button" && text(node).includes("Add token")).props.onClick();
  assert.deepEqual(find(render(), (node) => node.props?.providerID === "claude-max").props.label, "Anthropic, setup token");
});

test("Add creates the provider the extension serves, then takes the step it needs", async () => {
  const sent = api();
  const { render, view } = mountShelf([workstation], { stateData: { ...data, providers: [...data.providers, { id: "openai_codex" }] } });
  trigger(render(), "workstation").props.onClick();
  find(rowFor(render(), "OpenAI Codex"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(sent, [["POST", "/providers", { type: "openai_codex", id: "openai_codex-2", extension: "workstation" }]]);
  assert.equal(view.changed, 1, "the state reloads, and the listing with it");
  assert.deepEqual(view.added, [["openai_codex", "openai_codex-2"]], "a sign-in provider asks for an account");

  find(rowFor(render(), "OpenCode Zen, anonymous"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1), ["POST", "/providers", { id: "opencode_zen_anonymous", type: "opencode_zen_anonymous", extension: "workstation" }]);
  assert.deepEqual(notices(render()), ["OpenCode Zen, anonymous added"]);
  assert.match(find(render(), (node) => node.props?.message).props.message.detail, /^It is configured as opencode_zen_anonymous\./);

  const tokenless = { ...workstation, providers: workstation.providers.slice(0, 2) };
  const second = mountShelf([tokenless]);
  trigger(second.render(), "workstation").props.onClick();
  find(rowFor(second.render(), "Anthropic, setup token"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1), ["POST", "/providers", { id: "anthropic_setup_token", type: "anthropic_setup_token", extension: "workstation" }]);
  assert.equal(find(second.render(), (node) => node.props?.providerID).props.providerID, "anthropic_setup_token", "a token provider asks for its token");
});

test("a provider the gateway refuses to add says why in the panel", async () => {
  api((method) => { if (method === "POST") throw Object.assign(new Error("extension \"workstation\" is not configured"), { status: 400 }); return {}; });
  const { render, view } = mountShelf([workstation]);
  trigger(render(), "workstation").props.onClick();
  find(rowFor(render(), "OpenAI Codex"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(notices(render()), ["OpenAI Codex wasn't added"]);
  assert.deepEqual(view.added, []);
});

test("unlisted extension providers can be added with their discovered auth methods", async () => {
  const sent = api();
  const discovered = { ...workstation, providers: [], status: { ...workstation.status, served: [
    { id: "fixture_account", name: "Fixture account", surfaces: ["responses"], credential: "oauth", has_oauth: true, oauth_methods: ["manual", "device"] },
    { id: "fixture_text", name: "Fixture text", surfaces: ["messages"], credential: "none" },
  ] } };
  const { render, view } = mountShelf([discovered], { stateData: { providers: [], provider_registry: [], provider_statuses: [] } });
  trigger(render(), "workstation").props.onClick();
  find(rowFor(render(), "Fixture account"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(sent[0], ["POST", "/providers", { id: "fixture_account", type: "fixture_account", extension: "workstation" }]);
  assert.deepEqual(view.added, [["fixture_account", "fixture_account"]]);
  find(rowFor(render(), "Fixture text"), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(sent[1], ["POST", "/providers", { id: "fixture_text", type: "fixture_text", extension: "workstation" }]);
});

test("Check now replaces the extension's status, and says when it could not run", async () => {
  const sent = api((method, path) => path.endsWith("/check") ? { ...buildBox.status } : {});
  const checked = listed([workstation]);
  const { render } = mountShelf([workstation], { state: checked.state });
  trigger(render(), "workstation").props.onClick();
  buttonIn(render(), "Check now").props.onClick();
  await settle();
  assert.deepEqual(sent, [["POST", "/extensions/workstation/check", {}]]);
  assert.deepEqual(checked.calls, [["setStatus", "workstation", buildBox.status]]);

  api(() => { throw new Error("Admin authentication required."); });
  const failing = mountShelf([workstation]);
  trigger(failing.render(), "workstation").props.onClick();
  buttonIn(failing.render(), "Check now").props.onClick();
  await settle();
  assert.deepEqual(notices(failing.render()), ["The check didn't run"]);
});

test("an unused extension is removed, and one in use names what uses it", async () => {
  let refused = false;
  const sent = api((method) => {
    if (method === "DELETE" && refused) throw Object.assign(new Error("extension \"build-box\" serves provider(s) codex"), { status: 409, detail: { providers: ["codex"] } });
    return { ok: true };
  });
  const { render, view } = mountShelf([workstation, buildBox]);
  trigger(render(), "build-box").props.onClick();
  assert.equal(buttonIn(render(), "Remove").props.disabled, false);
  assert.equal(find(render(), (node) => node.props?.reason !== undefined).props.reason, "");
  buttonIn(render(), "Remove").props.onClick();
  await settle();
  assert.deepEqual(sent, [["DELETE", "/extensions/build-box", undefined]]);
  assert.equal(view.changed, 1);
  assert.equal(trigger(render(), "build-box").props["aria-expanded"], false);

  refused = true;
  trigger(render(), "build-box").props.onClick();
  buttonIn(render(), "Remove").props.onClick();
  await settle();
  const message = find(render(), (node) => node.props?.message).props.message;
  assert.equal(message.title, "Build box is still in use, so it wasn't removed");
  assert.equal(message.detail, "Provider codex uses this extension. Remove it, or name another extension for it, first.");
  assert.equal(view.changed, 2, "the listing is stale, so it reloads");
});

test("a daemon that needs attention says so in its panel, and what it affects", () => {
  api();
  const exposed = { ...workstation, status: { ...workstation.status, unauthenticated: true, outdated: true, version: "0.0.3" } };
  let shown = mountShelf([exposed]);
  assert.match(text(trigger(shown.render(), "workstation")), /Reachable · 14 ms$/);
  trigger(shown.render(), "workstation").props.onClick();
  let tree = shown.render();
  assert.deepEqual(notices(tree), ["This daemon answers without its secret"]);
  assert.doesNotMatch(text(tree), /This gateway expects/);

  const silent = { ...workstation, status: buildBox.status };
  shown = mountShelf([silent]);
  trigger(shown.render(), "workstation").props.onClick();
  tree = shown.render();
  const alert = find(tree, (node) => node.type === "div" && node.props?.class === "notice notice--warning");
  assert.equal(text(find(alert, (node) => node.type === "strong")), "copilot, edge_tts and claude-max can't serve requests");
  assert.match(text(alert), /Start the daemon, or change the address\.$/);
  assert.ok(findAll(tree, (node) => node.type === "div").map(text).includes("Errorthe extension did not answer within 5s"));
  assert.deepEqual(rowsOf(tree).map((row) => text(findAll(row, (node) => node.type === "td")[0])), ["github_copilot", "edge_tts", "anthropic_setup_token"], "offline rows do not invent names or capabilities");
});

test("a search opens the extension a match is in, showing what matches", () => {
  api();
  const { render, view } = mountShelf([workstation, buildBox]);
  render();
  view.search = "copilot";
  let tree = render();
  tree = render();
  assert.equal(trigger(tree, "workstation").props["aria-expanded"], true);
  assert.equal(trigger(tree, "build-box"), undefined);
  assert.deepEqual(rowsOf(tree).map((row) => text(findAll(row, (node) => node.type === "td")[0])), ["GitHub Copilot"]);
  view.search = "ollama";
  assert.equal(render(), null, "nothing inside answers, so the shelf steps aside");
  view.search = "";
  render();
  tree = render();
  assert.equal(trigger(tree, "workstation").props["aria-expanded"], false, "clearing the search closes it, as the hub closes its own");
  view.filter = "official";
  render();
  tree = render();
  assert.deepEqual(rowsOf(tree).map((row) => text(findAll(row, (node) => node.type === "td")[0])), ["GitHub Copilot", "OpenAI Codex", "Google Antigravity"]);
});

test("without an extension the shelf explains discovery without advertising providers", () => {
  api();
  const { render, view } = mountShelf([]);
  let tree = render();
  assert.match(text(tree), /No extension yet/);
  assert.match(text(tree), /Its providers, supported APIs, and sign-in methods appear here after discovery/);
  assert.doesNotMatch(text(tree), /Copilot|Codex|Antigravity|Edge TTS|Zen|Anthropic/);
  assert.equal(find(tree, (node) => node.type === "ul"), undefined);
  view.search = "copilot";
  assert.equal(render(), null, "an unknown extension does not claim this provider");
  view.search = "ollama";
  assert.equal(render(), null);
  view.search = "";
  buttonIn(render(), "Add extension").props.onClick();
  tree = render();
  const form = find(tree, (node) => node.props?.minimumVersion !== undefined && node.props?.onSaved);
  assert.ok(form, "the form opens in the shelf");
  assert.equal(form.props.extension, undefined);
  assert.equal(find(tree, (node) => node.type === "article").props.id, "extension-add-panel");
});

test("a load names the old variables still set, says when it fails, and keeps its place", async () => {
  api();
  let shown = mountShelf([], { state: listed([], { legacyEnvironment: true }).state });
  assert.deepEqual(notices(shown.render()), ["LLMGW_EXTENSION_URL and LLMGW_EXTENSION_SECRET are no longer read"]);
  assert.equal(find(shown.render(), (node) => node.props?.message).props.message.detail, "The gateway's environment still sets them. Add the daemon here, then remove the variables.");

  shown = mountShelf([], { state: listed([], { listing: null, loading: true }).state });
  const placeholder = find(shown.render(), (node) => node.props?.role === "status");
  assert.equal(text(placeholder), "Checking extensions…");
  assert.match(placeholder.props.class, /extension-row/, "it holds a row's place");

  const failed = listed([], { listing: null, error: "Extension store unavailable." });
  shown = mountShelf([], { state: failed.state });
  const notice = find(shown.render(), (node) => node.props?.message);
  assert.deepEqual([notice.props.message.title, notice.props.message.detail], ["The extensions could not be loaded", "Extension store unavailable."]);
  find(notice, (node) => node.type === "button" && text(node).includes("Retry")).props.onClick();
  assert.deepEqual(failed.calls, [["reload"]]);
});

test("Escape closes the open extension and stops there", () => {
  api();
  const { render } = mountShelf([workstation]);
  trigger(render(), "workstation").props.onClick();
  const keys = [];
  const key = (defaultPrevented) => ({ key: "Escape", defaultPrevented, preventDefault() { keys.push("prevented"); }, stopPropagation() { keys.push("stopped"); } });
  find(render(), (node) => node.type === "section").props.onKeyDown(key(true));
  assert.equal(trigger(render(), "workstation").props["aria-expanded"], true, "a dialog's Escape is the dialog's");
  find(render(), (node) => node.type === "section").props.onKeyDown(key(false));
  assert.equal(trigger(render(), "workstation").props["aria-expanded"], false);
  assert.deepEqual(keys, ["stopped", "prevented", "stopped"]);
});

test("Edit opens the extension's form in its panel", () => {
  api();
  const { render } = mountShelf([workstation]);
  trigger(render(), "workstation").props.onClick();
  buttonIn(render(), "Edit").props.onClick();
  const form = find(render(), (node) => node.props?.onSaved && node.props?.extension);
  assert.equal(form.props.extension, workstation);
});

function mountForm(extension) {
  const saved = [];
  let cancelled = 0;
  const render = mount(() => shelf.ExtensionForm({ extension, minimumVersion: "0.0.4", onCancel: () => { cancelled += 1; }, onSaved: async (value) => { saved.push(value); } }));
  const field = (tree, id) => find(tree, (node) => node.type === "input" && node.props.id === find(tree, (label) => label.type === "label" && text(label) === id).props.for);
  return { render, saved, cancelled: () => cancelled, field };
}

test("a check tries the address and secret as typed, and says what it found", async () => {
  const sent = api((method, path) => path === "/extensions/check" ? { ...workstation.status, latency_ms: 12 } : {});
  const form = mountForm();
  let tree = form.render();
  form.field(tree, "Address").props.onInput(input("http://127.0.0.1:18888"));
  form.field(form.render(), "Shared secret").props.onInput(input("fixture-secret"));
  buttonIn(form.render(), "Check connection").props.onClick();
  await settle();
  tree = form.render();
  assert.deepEqual(sent, [["POST", "/extensions/check", { url: "http://127.0.0.1:18888", secret: "fixture-secret" }]]);
  const result = find(tree, (node) => node.props?.status && node.props?.address !== undefined);
  assert.equal(result.props.address, "http://127.0.0.1:18888");
  assert.ok(buttonIn(tree, "Check again"));
  // Typing a new address leaves no stale answer behind.
  form.field(tree, "Address").props.onInput(input("http://127.0.0.1:18889"));
  assert.equal(find(form.render(), (node) => node.props?.status && node.props?.address !== undefined), undefined);

  const connected = shelf.CheckResult({ status: { ...workstation.status, latency_ms: 12 }, address: "http://127.0.0.1:18888", minimumVersion: "0.0.4" });
  const success = find(connected, (node) => node.props?.message?.tone === "success");
  assert.deepEqual([success.props.message.title, success.props.message.detail], ["Connected", "The extension (0.0.4) answered in 12 ms. It serves 6 providers:"]);
  assert.deepEqual(findAll(success, (node) => node.props?.class === "surface-chip").map(text), ["GitHub Copilot", "OpenAI Codex", "Google Antigravity", "Edge TTS", "OpenCode Zen, anonymous", "Anthropic, setup token"]);
  const warned = shelf.CheckResult({ status: { ...workstation.status, unauthenticated: true, outdated: true, version: "0.0.3" }, address: "x", minimumVersion: "0.0.4" });
  assert.deepEqual(findAll(warned, (node) => node.props?.message).map((node) => node.props.message.title), ["Connected", "This daemon answers without its secret"]);
  const failed = shelf.CheckResult({ status: buildBox.status, address: "http://127.0.0.1:18888", minimumVersion: "0.0.4" });
  assert.equal(failed.props.message.title, "Nothing answered at http://127.0.0.1:18888");
  // Independent extensions need not use one implementation's environment names.
  const notice = shelf.MessageNotice({ message: ext.unauthenticatedWarning });
  assert.equal(notice.props.role, "alert");
  assert.deepEqual(findAll(notice, (node) => node.props?.class === "technical").map(text), []);
});

test("a check without what it needs says so before sending anything", async () => {
  const sent = api();
  const form = mountForm();
  buttonIn(form.render(), "Check connection").props.onClick();
  await settle();
  assert.deepEqual(findAll(form.render(), (node) => node.props?.message).map((node) => node.props.message.title), ["Enter the address first"]);
  form.field(form.render(), "Address").props.onInput(input("http://127.0.0.1:18888"));
  assert.deepEqual(findAll(form.render(), (node) => node.props?.message), [], "typing clears what no longer applies");
  buttonIn(form.render(), "Check connection").props.onClick();
  await settle();
  assert.deepEqual(findAll(form.render(), (node) => node.props?.message).map((node) => node.props.message.title), ["Enter the shared secret first"]);
  assert.deepEqual(sent, []);
});

test("adding saves the extension, and a gateway without the key says how to store it", async () => {
  let keyless = false;
  const sent = api((method, path) => {
    if (method === "POST" && path === "/extensions" && keyless) throw Object.assign(new Error("LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to store an extension's secret, which the gateway never stores in plaintext"), { status: 400 });
    return { id: "build-box", name: "Build box" };
  });
  const form = mountForm();
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(findAll(form.render(), (node) => node.props?.message).map((node) => node.props.message.title), ["Enter a name"]);
  form.field(form.render(), "Name").props.onInput(input("Build box"));
  form.field(form.render(), "Address").props.onInput(input("http://extension:18888"));
  form.field(form.render(), "Shared secret").props.onInput(input("fixture-secret"));
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent, [["POST", "/extensions", { name: "Build box", url: "http://extension:18888", secret: "fixture-secret" }]]);
  assert.deepEqual(form.saved, [{ id: "build-box", name: "Build box" }]);
  assert.equal(form.field(form.render(), "Shared secret").props.value, "", "the secret does not stay in the form");

  keyless = true;
  form.field(form.render(), "Shared secret").props.onInput(input("fixture-secret"));
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  const refusal = find(form.render(), (node) => node.props?.message);
  assert.equal(refusal.props.message.title, "The secret can't be stored yet");
  assert.ok(refusal.props.icon, "with the lock that says why");
  buttonIn(form.render(), "Cancel").props.onClick();
  assert.equal(form.cancelled(), 1);
});

test("editing keeps the stored secret unless another is typed", async () => {
  const sent = api((method, path) => path.endsWith("/check") ? workstation.status : workstation);
  const form = mountForm(workstation);
  let tree = form.render();
  assert.equal(form.field(tree, "Name").props.value, "Workstation");
  assert.equal(form.field(tree, "Address").props.value, "http://127.0.0.1:18888");
  assert.equal(form.field(tree, "Shared secret").props.value, "");
  assert.match(text(tree), /Leave it empty to keep the stored one\./);
  buttonIn(tree, "Check connection").props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1), ["POST", "/extensions/workstation/check", {}], "the stored secret is checked where it is");
  form.field(form.render(), "Address").props.onInput(input("http://127.0.0.1:18889"));
  buttonIn(form.render(), "Check connection").props.onClick();
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(findAll(form.render(), (node) => node.props?.message).map((node) => node.props.message.title), ["Enter the secret to check a new address"]);
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent.at(-1), ["PATCH", "/extensions/workstation", { name: "Workstation", url: "http://127.0.0.1:18889" }]);
  form.field(form.render(), "Shared secret").props.onInput(input("fixture-replacement"));
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent.at(-1), ["PATCH", "/extensions/workstation", { name: "Workstation", url: "http://127.0.0.1:18889", secret: "fixture-replacement" }]);
  assert.ok(buttonIn(form.render(), "Save changes"));
});

test("the secret can be shown while it is typed", () => {
  api();
  const form = mountForm();
  const toggle = () => find(form.render(), (node) => node.type === "button" && /the secret$/.test(node.props["aria-label"] ?? ""));
  assert.equal(form.field(form.render(), "Shared secret").props.type, "password");
  assert.deepEqual([toggle().props["aria-label"], toggle().props["aria-pressed"]], ["Show the secret", false]);
  toggle().props.onClick();
  assert.equal(form.field(form.render(), "Shared secret").props.type, "text");
  assert.deepEqual([toggle().props["aria-label"], toggle().props["aria-pressed"]], ["Hide the secret", true]);
  assert.match(form.field(form.render(), "Shared secret").props["aria-describedby"], /-help$/);
});

test("a discovered provider's token is stored on its own binding and cleared from the form", async () => {
  let fail = false;
  const sent = api(() => { if (fail) throw new Error("LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to store an Anthropic setup token"); return { ok: true }; });
  let saved = 0;
  let closed = 0;
  const render = mount(() => shelf.ExtensionTokenDialog({ providerID: "fixture-token", providerType: "fixture_token", extensionID: "workstation", label: "Fixture token", onClose: () => { closed += 1; }, onSaved: async () => { saved += 1; } }));
  find(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(text(find(render(), (node) => node.props?.role === "alert")), "Paste the token first.");
  find(render(), (node) => node.type === "input").props.onInput(input("sk-ant-oat01-fixture"));
  find(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent, [["POST", "/providers", { id: "fixture-token", type: "fixture_token", extension: "workstation", api_key: "sk-ant-oat01-fixture", credential_kind: "api_key" }]]);
  assert.deepEqual([saved, closed], [1, 1]);
  fail = true;
  find(render(), (node) => node.type === "input").props.onInput(input("sk-ant-oat01-fixture"));
  find(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.match(text(find(render(), (node) => node.props?.role === "alert")), /LLMGW_CREDENTIAL_ENCRYPTION_KEY/);
  assert.equal(find(render(), (node) => node.type === "input").props.value, "");
});

const otherRegistry = [registry[4], { id: "openai", label: "OpenAI", protocol: "openai", availability: "available", auth_methods: ["api_key"], categories: ["api-key"] }];
function hub(mode, listing = { extensions: [workstation], minimum_version: "0.0.4", legacy_environment: false }) {
  const sent = api((method, path) => path === "/extensions" ? listing : { entries: [] });
  const configured = data.provider_statuses.filter((entry) => entry.configured).map((entry) => ({ ...entry, custom: true }));
  const hubData = { ...data, provider_registry: otherRegistry, provider_statuses: [...configured, ...otherRegistry.map((entry) => ({ ...entry, configured: false, configured_provider_ids: [], instances: [] }))] };
  const view = { search: "" };
  const render = mount(() => ProviderHub({ data: hubData, mode, onChanged: async () => {}, onOpenDetail() {} }));
  return { render, sent, view };
}
const shelfNode = (tree) => find(tree, (node) => node.props?.extensions && node.props?.onAddAccount);
const triggers = (tree) => findAll(tree, (node) => node.props?.["data-provider-trigger"]).map((node) => node.props["data-provider-trigger"]);

test("the administrator's hub shows Extensions first, and the daemon's providers only there", async () => {
  const admin = hub("admin");
  admin.render();
  await settle();
  const tree = admin.render();
  assert.deepEqual(admin.sent.filter(([, path]) => path === "/extensions"), [["GET", "/extensions"]]);
  const order = findAll(tree, (node) => node === shelfNode(tree) || (node.type === "section" && node.props?.class === "provider-group"));
  assert.equal(order[0], shelfNode(tree), "the Extensions shelf comes before every other shelf");
  assert.deepEqual(shelfNode(tree).props.extensions.extensions.map((extension) => extension.id), ["workstation"]);
  const shown = triggers(tree);
  for (const id of ["github_copilot", "openai_codex", "google_antigravity", "edge_tts", "claude-max"]) assert.ok(!shown.includes(id), `${id} lives under its extension`);
  assert.ok(shown.includes("openai") && shown.includes("anthropic"), "the providers the gateway reaches itself stay");

  // An account added from an extension's panel uses the hub's sign-in.
  shelfNode(tree).props.onAddAccount({ id: "github_copilot", extension_provider: true, oauth_methods: ["device"] }, "copilot");
  const dialog = find(admin.render(), (node) => node.props?.entry && node.props?.providerID === "copilot" && node.props?.ownerID !== undefined);
  assert.equal(dialog.props.entry.id, "github_copilot");

  const portal = hub("portal");
  portal.render();
  await settle();
  assert.equal(shelfNode(portal.render()), undefined);
  assert.deepEqual(portal.sent.filter(([, path]) => path === "/extensions"), []);
  assert.ok(triggers(portal.render()).includes("github_copilot"), "a portal keeps today's shelves");
});

test("a search only the Extensions shelf answers is not reported as no match", async () => {
  const admin = hub("admin");
  admin.render();
  await settle();
  const search = find(admin.render(), (node) => node.type === "input" && node.props?.placeholder === "Search name, API or instance ID");
  search.props.onInput(input("copilot"));
  let tree = admin.render();
  assert.equal(find(tree, (node) => node.props?.title === "No matching provider"), undefined);
  assert.equal(shelfNode(tree).props.search, "copilot");
  assert.match(text(find(tree, (node) => node.props?.class === "provider-hub__context")), /^1 provider · /, "what the shelf shows counts");
  find(tree, (node) => node.type === "input" && node.props?.placeholder === "Search name, API or instance ID").props.onInput(input("no-such-provider"));
  tree = admin.render();
  assert.ok(find(tree, (node) => node.props?.title === "No matching provider"));
});
