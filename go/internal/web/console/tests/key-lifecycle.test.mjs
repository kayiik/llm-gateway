import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, find, findAll, mount, settle, text } from "./hook-harness.mjs";
import { fakeKeyListing } from "./key-listing.mjs";

const { ApiKeys } = await bundle(fileURLToPath(new URL("../src/pages/ApiKeys.tsx", import.meta.url)), [
  { filter: /\/lib\/api$/, contents: "export const sendJSON = (...args) => globalThis.__api.sendJSON(...args);\nexport const getJSON = (...args) => globalThis.__api.getJSON(...args);" },
]);
const { KeyAccessInspector } = await bundle(fileURLToPath(new URL("../src/components/KeyAccessInspector.tsx", import.meta.url)), [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args);" },
]);

const key = (id, status, expiresAt = 0) => ({ id, name: id, status, project_id: "project-1", principal_id: "user-1", principal: "Ada", principal_kind: "human", created: 1798700000, expires_at: expiresAt });
const keys = [key("live", "active"), key("paused", "disabled"), key("gone", "revoked"), key("lapsed", "active", 1000000000), key("old", "revoked")];
// The administrator state counts keys, and memberships name their principal.
const data = {
  projects: [{ id: "project-1", name: "Project one", status: "active" }],
  memberships: [{ project_id: "project-1", principal_id: "user-1", role: "owner", principal_name: "Ada", principal_kind: "human", principal_status: "active" }],
  counts: { keys: keys.length },
};

// keysPage mounts the administrator's key list, served from keys, and waits
// for its first page.
async function keysPage() {
  const sent = [];
  const confirmations = [];
  const listing = fakeKeyListing(keys);
  globalThis.window = { confirm: (message) => { confirmations.push(message); return true; } };
  globalThis.__api = {
    getJSON: async (mode, path) => listing.answer(path),
    sendJSON: async (mode, path, method, body) => { sent.push({ mode, path, method, body }); return { deleted: body?.ids ?? [], refused: [] }; },
  };
  const mounted = mount(() => ApiKeys({ data, mode: "admin", onChanged: async () => {} }));
  mounted();
  await settle();
  // render shows the page as it stands once the list has loaded.
  const render = async () => { mounted(); await settle(); return mounted(); };
  return { sent, confirmations, render, requests: listing.requests };
}
const shown = (tree) => findAll(tree, (node) => node.type === "tr" && node.key).map((row) => row.key);
const statusSelect = (tree) => find(tree, (node) => node.type === "select" && findAll(node, (option) => option.props?.value === "ended").length);
const button = (tree, label) => find(tree, (node) => node.type === "button" && node.props?.["aria-label"] === label);
const check = (tree, label, checked = true) => find(tree, (node) => node.type === "input" && node.props?.["aria-label"] === label).props.onChange({ currentTarget: { checked } });

test("the key list hides revoked and expired keys until the status filter shows them", async () => {
  const { render, requests } = await keysPage();
  let tree = await render();
  assert.deepEqual(shown(tree), ["live", "paused"]);
  assert.match(requests[0], /^\/keys\?status=usable&limit=25&offset=0$/, "the server filters and pages the list");
  statusSelect(tree).props.onChange({ currentTarget: { value: "ended" } });
  tree = await render();
  assert.deepEqual(shown(tree), ["gone", "lapsed", "old"]);
  statusSelect(tree).props.onChange({ currentTarget: { value: "all" } });
  tree = await render();
  assert.deepEqual(shown(tree), ["live", "paused", "gone", "lapsed", "old"]);
  find(tree, (node) => node.type === "th" && text(node) === "Name").props.children.props.onClick();
  tree = await render();
  assert.match(requests.at(-1), /sort=name&order=asc/, "a header asks the server for its order");
});

test("a key that works is revoked and one that no longer works is deleted", async () => {
  const { sent, render, requests } = await keysPage();
  let tree = await render();
  statusSelect(tree).props.onChange({ currentTarget: { value: "all" } });
  tree = await render();
  for (const id of ["live", "paused"]) {
    assert.ok(button(tree, `Revoke ${id}`), `${id} can be revoked`);
    assert.equal(button(tree, `Delete ${id}`), undefined, `${id} still works, so it cannot be deleted`);
  }
  for (const id of ["gone", "lapsed", "old"]) {
    assert.ok(button(tree, `Delete ${id}`), `${id} can be deleted`);
    assert.equal(button(tree, `Revoke ${id}`), undefined, `${id} no longer works, so revoking it means nothing`);
  }
  const statusActions = findAll(tree, (node) => node.type === "button" && ["Enable", "Disable"].includes(text(node))).map(text);
  assert.deepEqual(statusActions, ["Disable", "Enable"], "only the keys that still work can be enabled or disabled");

  const loaded = requests.length;
  button(tree, "Revoke live").props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1), { mode: "admin", path: "/keys?id=live", method: "DELETE", body: undefined });
  tree = await render();
  assert.ok(requests.length > loaded, "a change reloads the list");
  button(tree, "Delete lapsed").props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1), { mode: "admin", path: "/keys/delete", method: "POST", body: { ids: ["lapsed"] } });
});

test("revoked and expired keys are deleted in bulk, only those the list shows", async () => {
  const { sent, confirmations, render } = await keysPage();
  let tree = await render();
  statusSelect(tree).props.onChange({ currentTarget: { value: "all" } });
  tree = await render();
  const selectable = findAll(tree, (node) => node.type === "input" && String(node.props?.["aria-label"]).startsWith("Select ") && !node.props.disabled)
    .map((node) => node.props["aria-label"]);
  assert.deepEqual(selectable, ["Select every revoked or expired key shown", "Select gone", "Select lapsed", "Select old"]);

  check(tree, "Select gone");
  tree = await render();
  check(tree, "Select old");
  tree = await render();
  const bulk = find(tree, (node) => node.type === "button" && /Delete 2 selected/.test(text(node)));
  assert.ok(bulk);
  bulk.props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1).body, { ids: ["gone", "old"] });
  assert.match(confirmations.at(-1), /Delete 2 keys\?/);
  tree = await render();
  assert.match(text(find(tree, (node) => node.props?.role === "status")), /2 keys deleted\./);

  check(tree, "Select every revoked or expired key shown");
  tree = await render();
  statusSelect(tree).props.onChange({ currentTarget: { value: "revoked" } });
  tree = await render();
  assert.equal(findAll(tree, (node) => node.type === "button" && /selected/.test(text(node))).length, 0, "changing the status filter clears the selection");
  check(tree, "Select every revoked or expired key shown");
  tree = await render();
  find(tree, (node) => node.type === "button" && /Delete 2 selected/.test(text(node))).props.onClick();
  await settle();
  assert.deepEqual(sent.at(-1).body, { ids: ["gone", "old"] }, "the expired key the filter hides is not deleted");
});

test("an administrator's key acts as an active person or service member of its project, named by the membership", async () => {
  const listing = fakeKeyListing([]);
  globalThis.window = { confirm: () => true };
  globalThis.__api = { getJSON: async (mode, path) => listing.answer(path), sendJSON: async () => ({}) };
  const members = {
    projects: [{ id: "project-1", name: "Project one", status: "active" }, { id: "project-2", name: "Project two", status: "active" }],
    memberships: [
      { project_id: "project-1", principal_id: "user-1", role: "owner", principal_name: "Ada", principal_kind: "human", principal_status: "active" },
      { project_id: "project-1", principal_id: "bot-1", role: "viewer", principal_name: "Batch", principal_kind: "service", principal_status: "active" },
      { project_id: "project-1", principal_id: "user-2", role: "member", principal_name: "Cy", principal_kind: "human", principal_status: "disabled" },
      { project_id: "project-2", principal_id: "user-3", role: "owner", principal_name: "Dee", principal_kind: "human", principal_status: "active" },
    ],
    counts: { keys: 0 },
  };
  const render = mount(() => ApiKeys({ data: members, mode: "admin", onChanged: async () => {}, initialContext: { projectID: "project-1" } }));
  render();
  await settle();
  const tree = render();
  const actsAs = find(tree, (node) => typeof node.type === "function" && node.props?.label === "Acts as");
  assert.deepEqual(actsAs.props.options.slice(2).map((option) => [option.value, option.label]), [["user-1", "Ada (human)"], ["bot-1", "Batch (service)"]],
    "a disabled member and another project's member cannot be chosen");
});

test("service identity requires an explicit choice before issuing a key", async () => {
  const sent = [];
  const listing = fakeKeyListing([]);
  globalThis.__api = {
    getJSON: async (mode, path) => listing.answer(path),
    sendJSON: async (mode, path, method, body) => { sent.push(body); return { token: "fixture-token" }; },
  };
  const render = mount(() => ApiKeys({ data, mode: "admin", onChanged: async () => {}, initialContext: { projectID: "project-1" } }));
  let tree = render();
  const actsAs = find(tree, (node) => typeof node.type === "function" && node.props?.label === "Acts as");
  assert.equal(actsAs.props.value, "__select_owner__");
  find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  tree = render();
  assert.equal(sent.length, 0, "an omitted owner cannot silently mint a service key");
  assert.match(text(tree), /explicitly select the service identity option/);
  actsAs.props.onChange("");
  tree = render();
  assert.match(text(tree), /Service identity selected/);
  find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(sent.length, 1);
  assert.equal("principal_id" in sent[0], false, "the server creates or reuses the selected service identity");
});

test("an administrator explicitly grants offline credential export on a new key", async () => {
  const sent = [];
  const listing = fakeKeyListing([]);
  globalThis.__api = {
    getJSON: async (mode, path) => listing.answer(path),
    sendJSON: async (mode, path, method, body) => { sent.push({ mode, path, body }); return { token: "fixture-token" }; },
  };
  const render = mount(() => ApiKeys({ data, mode: "admin", onChanged: async () => {}, initialContext: { projectID: "project-1" } }));
  let tree = render();
  const editor = find(tree, (node) => typeof node.type === "function" && node.type.name === "KeyScopeEditor");
  assert.equal(editor.props.canEditOfflineAccess, true);
  assert.equal(editor.props.policy.offline_access, false, "ordinary keys do not export credentials by default");
  editor.props.onChange({ ...editor.props.policy, offline_access: true });
  find(tree, (node) => typeof node.type === "function" && node.props?.label === "Acts as").props.onChange("");
  tree = render();
  find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual({ mode: sent[0].mode, path: sent[0].path, offline_access: sent[0].body.offline_access },
    { mode: "admin", path: "/keys", offline_access: true });
});

test("access inspector shows backend-filtered routes and direct models for a saved key", async () => {
  const listing = fakeKeyListing([key("live", "active")]);
  const requests = [];
  globalThis.__api = {
    getJSON: async (mode, path) => {
      requests.push(`${mode} ${path}`);
      if (path === "/keys/live/access") return { status: "active", principal_kind: "human", data: [
        { id: "coding", owned_by: "endpoint", failover: [{ provider: "eligible", model: "fixture" }] },
        { id: "eligible/direct", owned_by: "eligible" },
      ] };
      return listing.answer(path);
    },
    sendJSON: async () => ({}),
  };
  const render = mount(() => ApiKeys({ data, mode: "admin", onChanged: async () => {} }));
  render();
  await settle();
  let tree = render();
  button(tree, "Inspect access for live").props.onClick({ currentTarget: { focus() {} } });
  tree = render();
  const access = find(tree, (node) => typeof node.type === "function" && node.props?.keyID === "live");
  assert.ok(access, "the key action opens the inspector for that key");
  const inspect = mount(() => KeyAccessInspector(access.props));
  inspect();
  await settle();
  tree = inspect();
  assert.ok(requests.includes("admin /keys/live/access"));
  const inspector = find(tree, (node) => node.props?.["aria-label"] === "Effective access for live");
  assert.match(text(inspector), /codingeligible\/fixture/);
  assert.match(text(inspector), /eligible\/direct/);
  assert.match(text(inspector), /No provider request is sent/);
});
