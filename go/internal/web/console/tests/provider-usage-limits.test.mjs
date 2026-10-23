import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, find, input, mount, settle, text } from "./hook-harness.mjs";

const apiStub = [{ filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args);" }];
const { ProviderUsageLimits, limitValues } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderUsageLimits.tsx", import.meta.url)), apiStub);
const { ProviderAllowance, allowanceValue } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderAllowance.tsx", import.meta.url)), apiStub);

test("limits-only save uses the instance binding and exact model limits without reposting provider credentials", async () => {
  const calls = [];
  globalThis.__api = { sendJSON: async (...args) => calls.push(args) };
  let refreshed = 0;
  const render = mount(() => ProviderUsageLimits({ provider: { id: "fixture-a", type: "openai_compatible", usage_limits: { rpm: 8, models: { "model/a": { daily_tokens: 120 } } } }, onSaved: async () => { refreshed++; } }));
  let tree = render();
  find(tree, (node) => node.props?.["aria-label"] === "Provider requests per minute").props.onInput(input("3"));
  tree = render();
  await find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["admin", "/providers/fixture-a/usage-limits", "PATCH", { usage_limits: { rpm: 3, models: { "model/a": { daily_tokens: 120 } } } }]]);
  assert.equal(refreshed, 1);
  assert.match(text(render()), /Limits saved/);
  find(render(), (node) => node.props?.["aria-label"] === "Provider requests per minute").props.onInput(input("-1"));
  await find(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.match(text(render()), /non-negative whole number/);
});

test("blank limits clear thresholds, and invalid precision cannot silently change a cap", () => {
  assert.deepEqual(limitValues({ rpm: "", daily_tokens: "0", monthly_tokens: "" }), {});
  for (const value of ["1.5", "1e4", "9007199254740993", "-1"]) {
    assert.throws(() => limitValues({ rpm: value, daily_tokens: "", monthly_tokens: "" }), /non-negative whole/);
  }
});

test("allowance distinguishes zero, unknown and stale and refreshes only the selected connection", async () => {
  const calls = [];
  const report = { quota_advisories: [{ provider_id: "fixture-a", status: "stale", dimensions: [] }] };
  globalThis.__api = { getJSON: async () => report, sendJSON: async (...args) => { calls.push(args); return { status: "unknown" }; } };
  const render = mount(() => ProviderAllowance({ providerIDs: ["fixture-a"], connections: [{ id: "connection-a", provider_id: "fixture-a", status: "active" }], mode: "admin" }));
  render(); await settle();
  assert.match(text(render()), /Previous allowance data is stale/);
  assert.match(text(render()), /Unknown does not mean zero/);
  await find(render(), (node) => node.type === "button").props.onClick();
  await settle();
  assert.deepEqual(calls, [["admin", "/connections/connection-a/quota/refresh", "POST", {}]]);
  assert.match(text(render()), /did not supply usable allowance data/);
  assert.equal(allowanceValue({ unit: "fraction", remaining: 0 }), "0% remaining");
  assert.equal(allowanceValue({ unit: "fraction", remaining: 0.5 }), "50% remaining");
  assert.equal(allowanceValue({ unit: "fraction" }), "Unknown");
});
