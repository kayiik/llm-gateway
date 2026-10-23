import { useEffect, useRef, useState } from "preact/hooks";
import { getJSON, type JSONRecord } from "../../lib/api";
import { asList, asRecord, numberValue, stringValue } from "../../lib/records";
import { sentenceCase } from "../../lib/text";
import { matchesDiscoveryFilter } from "./ProviderRoster";
import { badgeTone, boolValue, statusLabel, tileStatus } from "./shared";

// Extensions are the companion daemons the gateway reaches the providers
// they serve through, each at an address with a shared secret. This module
// reads what the administrator API says of them; ExtensionShelf shows it.

export type Tone = "ready" | "attention" | "muted";
export type Pill = { label: string; tone: Tone };

// extensionPill says at a glance whether an extension answers: how fast,
// or what went wrong, or that nothing has checked it yet.
export function extensionPill(status: unknown): Pill {
  const checked = asRecord(status);
  if (boolValue(checked.reachable)) {
    return { label: `Reachable · ${numberValue(checked.latency_ms)} ms`, tone: "ready" };
  }
  const code = stringValue(checked.error_code);
  if (!boolValue(checked.probed) && !code) return { label: "Not checked", tone: "muted" };
  const label = ({ secret_refused: "Secret refused", not_an_extension: "Not a companion daemon", no_answer: "No answer" } as Record<string, string>)[code];
  return { label: label ?? "Error", tone: "attention" };
}

// servedSummary says how many providers an extension serves, which only a
// daemon that answered can say, and how many configured providers use it.
export function servedSummary(extension: JSONRecord): string {
  const status = asRecord(extension.status);
  const inUse = asList(extension.providers).length;
  if (boolValue(status.reachable)) {
    const served = asList(status.served).length;
    return `Serves ${served} provider${served === 1 ? "" : "s"} · ${inUse ? `${inUse} in use` : "none in use"}`;
  }
  return inUse ? `${inUse} provider${inUse === 1 ? "" : "s"} in use` : "No providers in use";
}

// answeredIn says how long a daemon took to answer its last check, refusal
// included, or that nothing answered or checked.
export function answeredIn(status: unknown): string {
  const checked = asRecord(status);
  const code = stringValue(checked.error_code);
  if (code === "no_answer") return "No answer";
  if (boolValue(checked.reachable) || (boolValue(checked.probed) && code)) return `${numberValue(checked.latency_ms)} ms`;
  return "Not checked";
}

const surfaceLabels: Record<string, string> = { chat_completions: "Chat", responses: "Responses", messages: "Messages", audio_speech: "Speech" };

// surfaceLabel names an API surface a daemon serves a provider on.
export function surfaceLabel(surface: string): string {
  return surfaceLabels[surface] ?? sentenceCase(surface);
}

const methodLabels: Record<string, string> = { device: "Device code", browser: "Browser", manual: "Paste a code" };

// signInLabel says how a provider's account or credential is obtained:
// signing in by one of its OAuth methods, pasting a token, or nothing.
export function signInLabel(credential: string, methods: string[]): string {
  if (credential === "token") return "Paste a token";
  if (credential === "none") return "None needed";
  if (credential !== "oauth") return "Not reported";
  const labels = methods.map((method) => methodLabels[method] ?? sentenceCase(method));
  if (!labels.length) return "Account sign-in";
  return labels.map((label, index) => index ? label[0].toLowerCase() + label.slice(1) : label).join(" or ");
}

// instanceSnapshots finds each configured provider's own status row among
// the tiles the state lists, by provider ID.
export function instanceSnapshots(data: JSONRecord): Map<string, JSONRecord> {
  const snapshots = new Map<string, JSONRecord>();
  for (const tile of asList(data.provider_statuses).map(asRecord)) {
    for (const instance of asList(tile.instances).map(asRecord)) {
      const id = stringValue(instance.id);
      if (id && !snapshots.has(id)) snapshots.set(id, instance);
    }
  }
  return snapshots;
}

// A ServedState is where a served provider stands in this gateway, and what
// it still needs before it can serve a request.
export type ServedState = Pill & { added: boolean; needs: "" | "account" | "token" };

// accountPhrases say an instance status after an account count, where the
// whole label would repeat a separator.
const accountPhrases: Record<string, string> = { configured: "unverified" };

// servedState derives a served provider's state from the configured
// instances of its type that the extension serves: their statuses, and for
// a sign-in provider how many accounts people connected.
export function servedState(credential: string, instances: JSONRecord[], unserved = false): ServedState {
  if (!instances.length) return { label: "Not added", tone: "muted", added: false, needs: "" };
  if (unserved) return { label: "Not served by this daemon", tone: "attention", added: true, needs: "" };
  const counts: Record<string, number> = {};
  for (const instance of instances) {
    const state = stringValue(instance.status, "configured");
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const reportedStatus = tileStatus({ instance_status_counts: counts, status: "configured" });
  const status = credential === "none" && reportedStatus === "needs_credentials" ? "configured" : reportedStatus;
  const tone = badgeTone(status);
  if (status === "disabled") return { label: "Disabled", tone, added: true, needs: "" };
  if (credential === "token" && status === "needs_credentials") return { label: "Added · needs a token", tone: "attention", added: true, needs: "token" };
  if (credential === "oauth") {
    const accounts = instances.reduce((sum, instance) => sum + numberValue(instance.connection_count), 0);
    if (!accounts) return { label: "Added · needs an account", tone: "attention", added: true, needs: "account" };
    const phrase = accountPhrases[status] ?? statusLabel(status)[0].toLowerCase() + statusLabel(status).slice(1);
    return { label: `${accounts} account${accounts === 1 ? "" : "s"} · ${phrase}`, tone, added: true, needs: "" };
  }
  return { label: statusLabel(status), tone, added: true, needs: "" };
}

// A ServedRow is one provider type an extension serves, as its panel lists
// it, with the configured instances of the type the extension serves.
export type ServedRow = {
  type: string;
  label: string;
  markID: string;
  registryID: string;
  surfaces: string[];
  credential: string;
  signIn: string;
  instances: JSONRecord[];
  // Configured to use this extension, of a type its daemon does not serve.
  unserved: boolean;
  // The extension reported enough information to configure it.
  addable: boolean;
  state: ServedState;
  // The registry entry, or a stand-in for a type without one, which the
  // hub's discovery filters read.
  entry: JSONRecord;
};

// servedRows lists what an extension serves: the providers its daemon said
// it serves, each joined with the configured providers of its type that
// resolve to the extension, then any of those whose type it did not name.
// A daemon that did not answer is represented by the configured providers.
export function servedRows(extension: JSONRecord, data: JSONRecord): ServedRow[] {
  const status = asRecord(extension.status);
  const reported = boolValue(status.reachable) ? asList(status.served).map(asRecord) : [];
  const configured = asList(extension.providers).map(asRecord);
  const snapshots = instanceSnapshots(data);
  const configuredTypes = configured.map((provider) => stringValue(provider.type)).filter(Boolean);
  const types = [...new Set([
    ...reported.map((info) => stringValue(info.id)).filter(Boolean),
    ...configuredTypes,
  ])];
  return types.map((type) => {
    const info = reported.find((candidate) => stringValue(candidate.id) === type);
    const label = stringValue(info?.name) || type;
    const credential = info ? stringValue(info.credential) || (boolValue(info.has_oauth) ? "oauth" : "") : "";
    const methods = asList(info?.oauth_methods).map(String).filter((method) => ["browser", "device", "manual"].includes(method));
    const instances = configured
      .filter((provider) => stringValue(provider.type) === type)
      .map((provider) => {
        const id = stringValue(provider.id);
        const snapshot = snapshots.get(id) ?? {};
        return { ...snapshot, id, disabled: boolValue(provider.disabled) || boolValue(snapshot.disabled) };
      });
    const unserved = boolValue(status.reachable) && !info;
    const authMethods = credential === "none" ? ["none"] : credential === "token" ? ["api_key"] : methods.map((method) => method === "device" ? "oauth_device" : "oauth_browser");
    return {
      type, label, markID: type, registryID: "",
      surfaces: asList(info?.surfaces).map(String),
      credential, signIn: signInLabel(credential, methods), instances, unserved,
      addable: Boolean(info) && (["none", "token"].includes(credential) || (credential === "oauth" && boolValue(info?.has_oauth) && methods.length > 0)),
      state: servedState(credential, instances, unserved),
      entry: { id: type, label, extension_provider: true, auth_methods: authMethods, oauth_methods: methods, categories: credential === "none" ? ["no-auth"] : [], configured: instances.length > 0 },
    };
  });
}

// rowMatches says whether a served row answers the hub's search and filter.
export function rowMatches(row: ServedRow, search: string, filter: string): boolean {
  const needle = search.trim().toLowerCase();
  const haystack = `${row.label} ${row.type} ${row.registryID} ${row.instances.map((instance) => stringValue(instance.id)).join(" ")}`.toLowerCase();
  return (!needle || haystack.includes(needle)) && matchesDiscoveryFilter(row.entry, filter);
}

// A ShelfItem is an extension the shelf shows, with the rows it shows of
// it; matched says the search or filter found a row inside it, which opens
// its panel.
export type ShelfItem = { extension: JSONRecord; rows: ServedRow[]; matched: boolean };

// shelfItems are the extensions the shelf shows under the hub's search and
// filter. Without either, every extension shows all it serves. A search an
// extension's own name or address answers shows it whole. Otherwise an
// extension shows only the rows that answer, and none answering hides it.
export function shelfItems(extensions: JSONRecord[], data: JSONRecord, search: string, filter: string): ShelfItem[] {
  const needle = search.trim().toLowerCase();
  const narrowing = Boolean(needle) || filter !== "all";
  return extensions.flatMap((extension): ShelfItem[] => {
    const rows = servedRows(extension, data);
    if (!narrowing) return [{ extension, rows, matched: false }];
    const named = `${stringValue(extension.name)} ${stringValue(extension.url)} ${stringValue(extension.id)}`.toLowerCase();
    if (filter === "all" && named.includes(needle)) return [{ extension, rows, matched: false }];
    const matching = rows.filter((row) => rowMatches(row, search, filter));
    return matching.length ? [{ extension, rows: matching, matched: true }] : [];
  });
}

// shelfShows says whether the Extensions shelf has anything to show under
// the hub's search and filter. Until the listing loads, it shows that.
export function shelfShows(state: { listing: JSONRecord | null; extensions: JSONRecord[] }, data: JSONRecord, search: string, filter: string): boolean {
  if (!state.listing) return true;
  if (!state.extensions.length) return filter === "all" && (!search.trim() || "extensions".includes(search.trim().toLowerCase()));
  return shelfItems(state.extensions, data, search, filter).length > 0;
}

// freeProviderID is base, or the first base-N no configured provider has:
// adding a provider is an upsert keyed on its ID, which must not replace
// one configured elsewhere.
export function freeProviderID(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

// addProviderBody is the provider an Add creates for a served row: from its
// registry entry, or of its type, served by the extension.
export function addProviderBody(row: ServedRow, extensionID: string, providerID: string): JSONRecord {
  return { id: providerID, type: row.type, extension: extensionID };
}

// providerBaseID is the ID a served row's provider is added under, unless a
// configured provider has it: its registry entry's default, or its own.
export function providerBaseID(row: ServedRow): string {
  return row.type;
}

// A Message is a notice's title and detail; reported is what the gateway
// said, shown as it said it.
export type Message = { tone: "success" | "warning" | "error"; title: string; detail: string; reported?: string };

// loopback reports an address on the machine itself, which a gateway in a
// container cannot reach a daemon on the host by.
function loopback(address: string): boolean {
  try {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

// checkFailure says why a check found no daemon to use, and what to change.
export function checkFailure(status: unknown, address: string): Message {
  const checked = asRecord(status);
  const reported = stringValue(checked.error);
  switch (stringValue(checked.error_code)) {
    case "secret_refused":
      return { tone: "error", title: "The daemon refused this secret", detail: "Enter the shared secret configured on this extension." };
    case "no_answer":
      return {
        tone: "error", title: `Nothing answered at ${address}`, reported,
        detail: `Check that the daemon is running and listens at this address.${loopback(address) ? " If the gateway runs in a container, 127.0.0.1 is the container itself: use the daemon's service name or the host's address." : ""}`,
      };
    case "not_an_extension":
      return { tone: "error", title: "That isn't a companion daemon", detail: "Something answered, but not as a companion daemon does at GET /extension/v1/info. Check the port, and any path a proxy adds in front of the daemon." };
  }
  return { tone: "error", title: "The check failed", detail: "Check the address and the secret, then check again.", reported };
}

// unauthenticatedWarning is for a daemon that also answers without its
// secret, and so serves anyone who reaches it.
export const unauthenticatedWarning: Message = {
  tone: "warning", title: "This daemon answers without its secret",
  detail: "Anyone who can reach it can use it. Configure the extension to require its shared secret.",
};

// The way out of each failure, when providers depend on the extension.
const unreachableRemedies: Record<string, string> = {
  no_answer: "Start the daemon, or change the address.",
  secret_refused: "Enter the secret the daemon was started with.",
  not_an_extension: "Change the address to where the daemon listens.",
};

// unreachableEffect says what an extension that cannot be used breaks: the
// enabled providers that resolve to it, which routes pass over.
export function unreachableEffect(extension: JSONRecord): { providers: string[]; detail: string } | null {
  const status = asRecord(extension.status);
  if (boolValue(status.reachable) || (!boolValue(status.probed) && !stringValue(status.error_code))) return null;
  const providers = asList(extension.providers).map(asRecord).filter((provider) => !boolValue(provider.disabled)).map((provider) => stringValue(provider.id)).filter(Boolean);
  if (!providers.length) return null;
  const remedy = unreachableRemedies[stringValue(status.error_code)] ?? "Check the error above, then check again.";
  return { providers, detail: `Routes skip ${providers.length === 1 ? "it" : "them"} and try their next member; a request only ${providers.length === 1 ? "it" : "they"} can serve fails. ${remedy}` };
}

// removalReason says why an extension cannot be removed: the providers that
// resolve to it, which the gateway would leave without a daemon.
export function removalReason(providers: string[]): string {
  if (!providers.length) return "";
  if (providers.length === 1) return `Provider ${providers[0]} uses this extension. Remove it, or name another extension for it, first.`;
  const names = `${providers.slice(0, -1).join(", ")} and ${providers[providers.length - 1]}`;
  return `Providers ${names} use this extension. Remove them, or name another extension for them, first.`;
}

// storeRefusal is the notice for an extension the gateway would not store:
// without the credential encryption key, a secret has nowhere to go.
export function storeRefusal(message: string, editing = false): Message {
  if (message.includes("LLMGW_CREDENTIAL_ENCRYPTION_KEY")) {
    return { tone: "warning", title: "The secret can't be stored yet", detail: `Extension secrets are only stored encrypted. Set LLMGW_CREDENTIAL_ENCRYPTION_KEY, restart the gateway, then ${editing ? "save the new secret" : "add the extension"}.` };
  }
  if (message.includes("already exists")) return { tone: "error", title: "That name is taken", detail: "An extension's ID comes from its name, and another extension has it. Choose another name.", reported: message };
  return { tone: "error", title: editing ? "The changes weren't saved" : "The extension wasn't added", detail: message };
}

// useExtensions loads the extensions while enabled. The listing follows the
// gateway's state, which every change to a provider or an extension
// reloads: what each extension serves changes with both. A check of one
// extension replaces its status alone.
export function useExtensions(enabled: boolean, data: JSONRecord) {
  const [listing, setListing] = useState<JSONRecord | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = async () => {
    const current = ++generation.current;
    if (!enabled) return;
    setLoading(true);
    setError("");
    try {
      const payload = await getJSON<JSONRecord>("admin", "/extensions");
      if (generation.current === current) setListing(asRecord(payload));
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : "The extensions could not be loaded.");
    } finally {
      if (generation.current === current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [enabled, data]);
  const setStatus = (id: string, status: JSONRecord) => setListing((current) => current
    ? { ...current, extensions: asList(current.extensions).map(asRecord).map((extension) => stringValue(extension.id) === id ? { ...extension, status } : extension) }
    : current);
  return {
    listing,
    extensions: asList(listing?.extensions).map(asRecord),
    minimumVersion: stringValue(listing?.minimum_version),
    legacyEnvironment: boolValue(listing?.legacy_environment),
    loading,
    error,
    reload: load,
    setStatus,
  };
}

export type ExtensionsState = ReturnType<typeof useExtensions>;
