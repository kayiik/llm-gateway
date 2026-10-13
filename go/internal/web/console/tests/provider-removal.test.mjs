import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, find, findAll, mount, settle, text } from "./hook-harness.mjs";

const stubs = [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args); export const sendForm = (...args) => globalThis.__api.sendForm(...args);" },
  { filter: /\/useDialogFocus$/, contents: "export const useDialogFocus = () => ({ current: null });" },
];
const shared = await bundle(fileURLToPath(new URL("../src/components/providers/shared.tsx", import.meta.url)), stubs);
const { RemovalBlockedNotice } = await bundle(fileURLToPath(new URL("../src/components/providers/RemovalBlockedNotice.tsx", import.meta.url)), stubs);
const { ProviderHub } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderHub.tsx", import.meta.url)), stubs);

// refusal is a removal the gateway refused, as the API client rejects it.
const refusal = (detail) => Object.assign(new Error("provider is still in use"), { status: 409, detail });

test("a refused removal is read for the routes and connections that keep the provider", () => {
  assert.deepEqual(shared.removalBlockOf("anthropic", refusal({ endpoints: ["fast", "smart"], connections: 3, principals: 2 })),
    { providerID: "anthropic", endpoints: ["fast", "smart"], connections: 3, principals: 2 });
  assert.deepEqual(shared.removalBlockOf("anthropic", refusal({ endpoints: [], connections: 1, principals: 1 })),
    { providerID: "anthropic", endpoints: [], connections: 1, principals: 1 });
  // A refusal that names neither, as an older gateway's, keeps its message.
  assert.equal(shared.removalBlockOf("anthropic", refusal({ error: { message: "provider still has active connections" } })), null);
  assert.equal(shared.removalBlockOf("anthropic", Object.assign(new Error("gone"), { status: 404, detail: { endpoints: ["fast"] } })), null);
  assert.equal(shared.removalBlockOf("anthropic", new Error("network")), null);
});

test("who still connects is counted in people, else in connections", () => {
  assert.equal(shared.connectionsInUseText({ endpoints: [], connections: 3, principals: 2 }), "2 people connected their own key or account.");
  assert.equal(shared.connectionsInUseText({ endpoints: [], connections: 2, principals: 1 }), "1 person connected their own key or account.");
  assert.equal(shared.connectionsInUseText({ endpoints: [], connections: 2, principals: 0 }), "2 private connections use it.");
  assert.equal(shared.connectionsInUseText({ endpoints: [], connections: 1, principals: 0 }), "1 private connection uses it.");
  assert.deepEqual(shared.joinNames(["a"], " and ", ", "), ["a"]);
  assert.equal(shared.joinNames(["a", "b"], " and ", ", ").join(""), "a and b");
  assert.equal(shared.joinNames(["a", "b", "c"], " and ", ", ").join(""), "a, b and c");
});

test("the notice names each route, links to Routes, and to where connections are managed", () => {
  const notice = RemovalBlockedNotice({ block: { providerID: "anthropic", endpoints: ["smart", "fast"], connections: 2, principals: 2 }, label: "Anthropic", connectionsHref: "#providers/anthropic" });
  assert.equal(notice.props.role, "alert");
  assert.match(text(notice), /^Anthropic is still in use, so it wasn't removed/);
  assert.match(text(notice), /The routes smart and fast send requests to it\.Open Routes/);
  assert.match(text(notice), /2 people connected their own key or account\.Manage connections$/);
  const links = findAll(notice, (node) => node.type === "a");
  assert.deepEqual(links.map((link) => [text(link), link.props.href]), [["Open Routes", "#routes"], ["Manage connections", "#providers/anthropic"]]);
  assert.deepEqual(findAll(notice, (node) => node.props?.class === "technical").map(text), ["smart", "fast"]);
  const one = RemovalBlockedNotice({ block: { providerID: "anthropic", endpoints: ["smart"], connections: 0, principals: 0 }, label: "Anthropic" });
  assert.match(text(one), /The route smart sends requests to it\.Open Routes$/);
  assert.doesNotMatch(text(one), /Manage connections/);
  // Where the connections are on the same page, the link moves there instead.
  let moved = false;
  const here = RemovalBlockedNotice({ block: { providerID: "anthropic-2", endpoints: [], connections: 1, principals: 1 }, label: "anthropic-2", onManageConnections: () => { moved = true; } });
  find(here, (node) => node.type === "button" && text(node) === "Manage connections").props.onClick();
  assert.equal(moved, true);
});

const registry = [{ id: "anthropic", label: "Anthropic", protocol: "anthropic", availability: "available", auth_methods: ["api_key"] }];
const anthropic = {
  ...registry[0], configured: true, configured_provider_ids: ["anthropic"],
  instances: [{ id: "anthropic", status: "verified" }], instance_status_counts: { verified: 1 },
};

// adminHub mounts the hub for an administrator, with the gateway answering
// every removal with refused, when set.
function adminHub() {
  const requests = [];
  const answer = { refused: null };
  globalThis.window = { confirm: () => true };
  globalThis.__api = {
    getJSON: async (mode, path) => { requests.push(["GET", path]); return { configured: false, entries: [] }; },
    sendJSON: async (mode, path, method) => { requests.push([method, path]); if (answer.refused) throw answer.refused; return { ok: true }; },
    sendForm: async () => ({}),
  };
  const render = mount(() => ProviderHub({
    data: { provider_registry: registry, provider_statuses: [anthropic], providers: [{ id: "anthropic" }] },
    mode: "admin", onChanged: async () => {}, onOpenDetail() {},
  }));
  const toggle = () => find(render(), (node) => node.props?.["data-provider-trigger"] === "anthropic").props.onClick();
  const remove = () => find(render(), (node) => node.type === "button" && text(node).includes("Remove")).props.onClick();
  return { render, requests, answer, toggle, remove };
}
const noticeIn = (tree) => find(tree, (node) => node.props?.block);
const topNotice = (tree) => find(tree, (node) => node.props && Object.hasOwn(node.props, "result"));

test("the hub shows a refused removal inside the provider's panel, not at the top", async () => {
  const hub = adminHub();
  hub.toggle();
  hub.answer.refused = refusal({ endpoints: ["fast", "smart"], connections: 3, principals: 2 });
  hub.remove();
  await settle();
  const tree = hub.render();
  assert.deepEqual(hub.requests.filter(([method]) => method === "DELETE"), [["DELETE", "/providers/anthropic"]]);
  const panel = find(tree, (node) => node.type === "article" && node.props?.["aria-label"] === "Anthropic");
  const notice = noticeIn(panel);
  assert.ok(notice, "the refusal is shown in the panel");
  assert.deepEqual(notice.props.block, { providerID: "anthropic", endpoints: ["fast", "smart"], connections: 3, principals: 2 });
  assert.equal(notice.props.label, "Anthropic");
  assert.equal(notice.props.connectionsHref, "#providers/anthropic");
  assert.equal(topNotice(tree).props.result, null, "nothing at the top repeats it");
  // Closing the panel leaves nothing stale behind for the next time it opens.
  hub.toggle();
  hub.render();
  hub.toggle();
  assert.equal(noticeIn(hub.render()), undefined);
});

test("a refusal that names nothing still says why, at the top", async () => {
  const hub = adminHub();
  hub.toggle();
  hub.answer.refused = refusal({ error: { message: "provider still has active connections" } });
  hub.remove();
  await settle();
  const tree = hub.render();
  assert.equal(noticeIn(tree), undefined);
  assert.equal(topNotice(tree).props.result.detail, "provider is still in use");
});
