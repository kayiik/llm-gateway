import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, find, findAll, mount, settle, text } from "./hook-harness.mjs";

const stubs = [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args); export const sendForm = (...args) => globalThis.__api.sendForm(...args);" },
  { filter: /\/useDialogFocus$/, contents: "export const useDialogFocus = () => ({ current: null });" },
];
const { OAuthConnectDialog } = await bundle(fileURLToPath(new URL("../src/components/providers/OAuthConnectDialog.tsx", import.meta.url)), stubs);
const { ProviderHub } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderHub.tsx", import.meta.url)), stubs);

const copilot = { id: "github_copilot", label: "GitHub Copilot", auth_methods: ["oauth_device"], onboarding_fields: ["human_owner"] };
const ada = { id: "ada", display_name: "Ada" };

function api() {
  const sent = [];
  globalThis.__api = {
    getJSON: async () => ({ principals: [], total: 0 }),
    sendJSON: async (mode, path, method, body) => { sent.push([mode, path, body]); throw new Error("the provider is unavailable"); },
    sendForm: async () => ({}),
  };
  return sent;
}
function dialog({ mode = "admin", ownerID = "ada", data = { default_owner: ada }, onClose = () => {} } = {}) {
  return mount(() => OAuthConnectDialog({ entry: copilot, providerID: "copilot", ownerID, data, mode, onClose, onComplete: async () => {} }));
}
// The owner select is the RemoteSearchSelect element the dialog renders.
const ownerSelect = (tree) => find(tree, (node) => node.props?.label === "Whose account is this?");
const continueButton = (tree) => find(tree, (node) => node.type === "button" && text(node).startsWith("Continue with"));

test("the sign-in asks whose account it is, starting from the page's owner", async () => {
  const sent = api();
  globalThis.window = { open: () => null, location: { hash: "" } };
  const render = dialog();
  let tree = render();
  const select = ownerSelect(tree);
  assert.equal(select.props.value, "ada");
  assert.equal(select.props.disabled, false);
  assert.equal(select.props.class, "owner-select");
  assert.deepEqual(JSON.parse(select.props.filterKey), { kinds: ["human"], status: "active" });
  assert.match(text(tree), /It becomes this person's private connection: their requests use it, nobody else's do\./);
  assert.equal(find(tree, (node) => node.props?.role === "alert"), undefined);
  // Another person chosen here owns the account, not the page's owner.
  select.props.onChange("grace");
  tree = render();
  assert.equal(ownerSelect(tree).props.value, "grace");
  assert.equal(continueButton(tree).props.disabled, false);
  continueButton(tree).props.onClick();
  await settle();
  assert.equal(sent[0][1], "/principals/grace/connections/copilot/oauth/start");
});

test("without a chosen person the sign-in cannot start", () => {
  api();
  const tree = dialog({ ownerID: "" })();
  assert.equal(ownerSelect(tree).props.value, "");
  assert.equal(ownerSelect(tree).props.emptyLabel, "Choose a person");
  assert.equal(continueButton(tree).props.disabled, true);
});

test("a gateway with no person says so and offers Access", () => {
  api();
  let closed = false;
  globalThis.window = { open: () => null, location: { hash: "providers" } };
  const render = dialog({ ownerID: "", data: {}, onClose: () => { closed = true; } });
  const tree = render();
  const notice = find(tree, (node) => node.props?.role === "alert");
  assert.match(text(notice), /^There's no person to own this account/);
  assert.match(text(notice), /Accounts belong to a person, and this gateway has none yet\. Add one in Access, then come back\./);
  assert.equal(ownerSelect(tree).props.disabled, true);
  assert.equal(ownerSelect(tree).props.emptyLabel, "No people yet");
  assert.equal(continueButton(tree).props.disabled, true);
  find(notice, (node) => node.type === "button" && text(node).includes("Add a person")).props.onClick();
  assert.equal(closed, true);
  assert.equal(globalThis.window.location.hash, "access");
});

test("a person signing in for themselves is not asked whose account it is", () => {
  api();
  const tree = dialog({ mode: "portal", ownerID: "", data: {} })();
  assert.equal(ownerSelect(tree), undefined);
  assert.equal(continueButton(tree).props.disabled, false);
});

// An OAuth registry entry the companion daemon does not serve, so the hub
// keeps it on its shelf.
const example = { id: "example_oauth", label: "Example", protocol: "openai", availability: "available", auth_methods: ["oauth_device"] };
function hubWith(instances, defaultOwner) {
  api();
  const status = { ...example, configured: true, configured_provider_ids: instances.map((instance) => instance.id), instances, instance_status_counts: { catalog_synced: instances.length } };
  const render = mount(() => ProviderHub({
    data: { provider_registry: [example], provider_statuses: [status], providers: instances.map(({ id }) => ({ id })), ...(defaultOwner ? { default_owner: defaultOwner } : {}) },
    mode: "admin", onChanged: async () => {}, onOpenDetail() {},
  }));
  render();
  find(render(), (node) => node.props?.["data-provider-trigger"] === "example_oauth").props.onClick();
  return render;
}
const button = (tree, label) => find(tree, (node) => node.type === "button" && text(node).includes(label));
const reasons = (tree) => findAll(tree, (node) => node.props?.reason !== undefined).map((node) => node.props.reason).filter(Boolean);

test("Add account works without a catalog owner, and checks say why they wait for one", () => {
  const render = hubWith([{ id: "example", status: "catalog_synced" }], null);
  let tree = render();
  assert.equal(button(tree, "Add account").props.disabled, false);
  assert.equal(button(tree, "Check reachability").props.disabled, true);
  assert.equal(button(tree, "Sync catalog").props.disabled, true);
  assert.deepEqual(reasons(tree), ["Checks run with a person's account. Choose a catalog owner at the top of the page."]);
  button(tree, "Add account").props.onClick();
  tree = render();
  const opened = find(tree, (node) => node.props?.entry && node.props?.providerID === "example");
  assert.ok(opened, "the sign-in opens for the instance");
  assert.equal(opened.props.ownerID, "", "and asks whose account it is itself");
});

test("with a catalog owner nothing waits, and several instances say why an account cannot join", () => {
  let tree = hubWith([{ id: "example", status: "catalog_synced" }], ada)();
  assert.equal(button(tree, "Check reachability").props.disabled, false);
  assert.deepEqual(reasons(tree), []);
  tree = hubWith([{ id: "example", status: "catalog_synced" }, { id: "example-2", status: "catalog_synced" }], ada)();
  assert.equal(button(tree, "Add account").props.disabled, true);
  assert.deepEqual(reasons(tree), ["Several instances are configured, so there's no single one for an account to join. Keep one instance to add an account."]);
});
