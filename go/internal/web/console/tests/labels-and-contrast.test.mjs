import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundle, find, findAll, mount, text } from "./hook-harness.mjs";

const stubs = [
  { filter: /\/lib\/api$/, contents: "export const getJSON = (...args) => globalThis.__api.getJSON(...args); export const sendJSON = (...args) => globalThis.__api.sendJSON(...args); export const sendForm = (...args) => globalThis.__api.sendForm(...args);" },
  { filter: /\/useDialogFocus$/, contents: "export const useDialogFocus = () => ({ current: null });" },
];
const { sentenceCase } = await bundle(fileURLToPath(new URL("../src/lib/text.ts", import.meta.url)));
const shared = await bundle(fileURLToPath(new URL("../src/components/providers/shared.tsx", import.meta.url)), stubs);
const roster = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderRoster.tsx", import.meta.url)), stubs);
const { ProviderHub } = await bundle(fileURLToPath(new URL("../src/components/providers/ProviderHub.tsx", import.meta.url)), stubs);
const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
const stylesheets = [base, ...["../src/styles/keys.css", "../src/components/providers/provider-hub.css", "../src/components/provider-marks.css"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))].join("\n");

test("labels the gateway reports are written in sentence case", () => {
  assert.equal(sentenceCase("needs_credentials"), "Needs credentials");
  assert.equal(sentenceCase("active"), "Active");
  assert.equal(sentenceCase("served"), "Served");
  assert.equal(sentenceCase(""), "");
  assert.equal(sentenceCase("API key required"), "API key required");
  for (const status of ["configured", "misconfigured", "catalog_synced", "verified", "check_failed", "disabled", "needs_credentials", "not_configured", "client_setup", "unavailable", "instances_ready", "instances_attention", "some_new_state"]) {
    assert.match(shared.statusLabel(status), /^[A-Z][^A-Z]*$/, status);
  }
  assert.equal(shared.statusLabel("some_new_state"), "Some new state");
  const metadata = roster.RosterMetadata({ entries: [{ id: "free", name: "Free", auth: "none", offer: "free_tier", base_url: "https://free.example/v1" }] });
  assert.deepEqual(findAll(metadata, (node) => typeof node.props?.class === "string" && node.props.class.startsWith("status-pill")).map(text), ["Free · no API key needed", "Free tier"]);
});

// rule returns the declarations of the first rule whose selector list is
// exactly selector.
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return base.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))?.[1] ?? "";
}

test("pills and meta text are not recased, and every pill tone is styled", () => {
  assert.doesNotMatch(rule(".status-pill"), /text-transform/);
  assert.doesNotMatch(rule(".provider-card__meta"), /text-transform/);
  assert.match(base, /\n\.status-pill--ready, \.status-pill--success \{ border-color: #c5dccd; background: #f1f7f2; color: #3f6e4d; \}/);
  assert.match(base, /:root\[data-theme="dark"\] \.status-pill--ready,\n:root\[data-theme="dark"\] \.status-pill--success,/);
});

test("a disabled control looks disabled and its hover promises nothing", () => {
  assert.match(rule(".button:disabled, .icon-button:disabled"), /opacity: 0\.5; cursor: not-allowed;/);
  assert.match(rule(".button:disabled:hover, .icon-button:disabled:hover"), /background: #fff;/);
  assert.match(rule(".button--primary:disabled:hover"), /background: #2f65aa;/);
  assert.match(base, /:root\[data-theme="dark"\] \.button:disabled:hover,\n:root\[data-theme="dark"\] \.icon-button:disabled:hover \{ background: #1c2026; \}/);
});

const channel = (hex) => {
  const value = hex.length === 4 ? hex.slice(1).split("").map((c) => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
};
const luminance = (hex) => { const [r, g, b] = channel(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };

test("light-theme text reads at 4.5:1 on its surface", () => {
  const failures = [];
  for (const [, selector, body] of stylesheets.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (selector.includes("data-theme")) continue;
    const color = body.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{3,6})\b/i)?.[1];
    if (!color) continue;
    const surface = body.match(/(?:^|;)\s*background:\s*(#[0-9a-f]{3,6})\b/i)?.[1] ?? "#fff";
    if (contrast(color, surface) < 4.5) failures.push(`${selector.trim()} ${color} on ${surface}`);
  }
  assert.deepEqual(failures, []);
});

test("dark-theme text the light rules colour gets a dark colour of its own", () => {
  const surface = "#171a1f";
  for (const selector of [".action-notice strong", ".action-notice span", ".form-stack label", ".owner-select", ".state-panel p", ".candidate-list strong", ".form-error", ".route-message", ".provider-group > header span", ".disabled-reason", ".notice li"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declared = base.match(new RegExp(`:root\\[data-theme="dark"\\] ${escaped}(?:,\\n[^{]*)?\\s*\\{[^}]*\\bcolor: (#[0-9a-f]{6})`));
    assert.ok(declared, `${selector} has a dark-theme colour`);
    assert.ok(contrast(declared[1], surface) >= 4.5, `${selector} reads on the dark surface`);
  }
});

test("a tile never synced says so instead of showing nothing", () => {
  globalThis.__api = { getJSON: async () => ({ entries: [] }), sendJSON: async () => ({}), sendForm: async () => ({}) };
  const entry = { id: "anthropic", label: "Anthropic", protocol: "anthropic", availability: "available", auth_methods: ["api_key"] };
  const render = mount(() => ProviderHub({
    data: { provider_registry: [entry], provider_statuses: [{ ...entry, configured: true, configured_provider_ids: ["anthropic"], catalog_refreshed: "", instances: [{ id: "anthropic", status: "configured" }], instance_status_counts: { configured: 1 } }], providers: [{ id: "anthropic" }] },
    mode: "admin", onChanged: async () => {}, onOpenDetail() {},
  }));
  render();
  find(render(), (node) => node.props?.["data-provider-trigger"] === "anthropic").props.onClick();
  const facts = findAll(render(), (node) => node.type === "div" && find(node, (child) => child.type === "dt")).map(text);
  assert.ok(facts.includes("Catalog freshnessCatalog not synced"), facts.join(" | "));
});
