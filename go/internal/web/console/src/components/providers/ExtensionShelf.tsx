import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, Lock, Pencil, Plug, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from "lucide-preact";
import { sendJSON, type JSONRecord } from "../../lib/api";
import { asList, asRecord, numberValue, stringValue } from "../../lib/records";
import { dataTable, useTableView, type TableColumn } from "../DataTable";
import { DisabledReason } from "../PageState";
import { ProviderMark } from "../ProviderMark";
import { useDialogFocus } from "../useDialogFocus";
import {
  type ExtensionsState,
  type Message,
  type ServedRow,
  addProviderBody,
  answeredIn,
  checkFailure,
  daemonTypes,
  extensionPill,
  freeProviderID,
  outdatedWarning,
  providerBaseID,
  removalReason,
  servedSummary,
  shelfItems,
  shelfShows,
  storeRefusal,
  surfaceLabel,
  unauthenticatedWarning,
  unreachableEffect,
} from "./extensions";
import { boolValue, joinNames } from "./shared";

// errorText is what a failed request says, for a notice.
function errorText(cause: unknown, fallback = "The gateway did not answer.") {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

// withTechnical sets the names an operator types, environment variables and
// the daemon's route, in the console's technical type.
function withTechnical(text: string): ComponentChildren {
  return text.split(/(LLMGW_[A-Z_]+|GET \/extension\/v1\/info)/).map((part, index) => index % 2 ? <span class="technical" key={index}>{part}</span> : part);
}

const noticeIcons = { success: CheckCircle2, warning: CircleAlert, error: CircleAlert };

// MessageNotice shows a Message: its title, why, and what the gateway said.
export function MessageNotice({ message, icon, children }: { message: Message; icon?: typeof Lock; children?: ComponentChildren }) {
  const Icon = icon ?? noticeIcons[message.tone];
  return (
    <div class={`notice notice--${message.tone}`} role={message.tone === "success" ? "status" : "alert"}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{message.title}</strong>
        <p>{withTechnical(message.detail)}</p>
        {message.reported ? <p class="technical">{message.reported}</p> : null}
        {children}
      </div>
    </div>
  );
}

// CheckResult says what a check of a daemon found: what it serves, or why
// the gateway cannot use it, and what about it needs attention.
export function CheckResult({ status, address, minimumVersion }: { status: JSONRecord; address: string; minimumVersion: string }) {
  if (!boolValue(status.reachable)) return <MessageNotice message={checkFailure(status, address)} />;
  const served = asList(status.served).map(asRecord);
  const version = stringValue(status.version);
  return (
    <>
      <MessageNotice message={{ tone: "success", title: "Connected", detail: `llmgw-extension ${version || "of an unreported version"} answered in ${numberValue(status.latency_ms)} ms. ${served.length ? `It serves ${served.length} provider${served.length === 1 ? "" : "s"}:` : "It serves no providers."}` }}>
        {served.length ? <div class="chip-row">{served.map((info) => <span class="surface-chip" key={stringValue(info.id)}>{daemonTypes.find((known) => known.type === stringValue(info.id))?.label ?? (stringValue(info.name) || stringValue(info.id))}</span>)}</div> : null}
      </MessageNotice>
      {boolValue(status.unauthenticated) ? <MessageNotice message={unauthenticatedWarning} icon={Lock} /> : null}
      {boolValue(status.outdated) ? <MessageNotice message={outdatedWarning(version, minimumVersion)} /> : null}
    </>
  );
}

// ExtensionForm adds an extension, or changes one: its name, address and
// secret, which a check tries as typed before anything is saved. A secret
// is never shown again once saved, so editing leaves it empty to keep it.
export function ExtensionForm({ extension, minimumVersion, onCancel, onSaved }: { extension?: JSONRecord; minimumVersion: string; onCancel: () => void; onSaved: (saved: JSONRecord) => Promise<void> }) {
  const editing = Boolean(extension);
  const extensionID = stringValue(extension?.id);
  const [name, setName] = useState(stringValue(extension?.name));
  const [address, setAddress] = useState(stringValue(extension?.url));
  const [secret, setSecret] = useState("");
  const [shown, setShown] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<JSONRecord | null>(null);
  const [checkError, setCheckError] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Message | null>(null);
  const nameID = useId();
  const addressID = useId();
  const secretID = useId();
  // A check answers for the address and secret it tried, not for new ones.
  const changed = () => {
    setChecked(null);
    setCheckError(null);
  };

  const check = async () => {
    changed();
    const url = address.trim();
    if (!url) {
      setCheckError({ tone: "error", title: "Enter the address first", detail: "The check reaches the daemon at the address you enter." });
      return;
    }
    // A saved extension's secret cannot be read back, so only its own
    // address can be checked with it.
    const saved = editing && !secret.trim() && url === stringValue(extension?.url);
    if (!saved && !secret.trim()) {
      setCheckError(editing
        ? { tone: "error", title: "Enter the secret to check a new address", detail: "The stored secret can't be read back, so a check of a changed address needs it typed again." }
        : { tone: "error", title: "Enter the shared secret first", detail: "The check sends it to the daemon, as the gateway will." });
      return;
    }
    setChecking(true);
    try {
      const status = saved
        ? await sendJSON<JSONRecord>("admin", `/extensions/${encodeURIComponent(extensionID)}/check`, "POST", {})
        : await sendJSON<JSONRecord>("admin", "/extensions/check", "POST", { url, secret });
      setChecked(asRecord(status));
    } catch (cause) {
      setCheckError({ tone: "error", title: asRecord(cause).status === 400 ? "Check the address" : "The check didn't run", detail: errorText(cause) });
    } finally {
      setChecking(false);
    }
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    setFailure(null);
    if (!name.trim()) {
      setFailure({ tone: "error", title: "Enter a name", detail: "It names the extension here and in request logs." });
      return;
    }
    if (!address.trim()) {
      setFailure({ tone: "error", title: "Enter the address", detail: "The gateway reaches the daemon at it." });
      return;
    }
    if (!editing && !secret.trim()) {
      setFailure({ tone: "error", title: "Enter the shared secret", detail: "The daemon was started with it, and the gateway sends it with every request." });
      return;
    }
    setSaving(true);
    try {
      const saved = editing
        ? await sendJSON<JSONRecord>("admin", `/extensions/${encodeURIComponent(extensionID)}`, "PATCH", { name: name.trim(), url: address.trim(), ...(secret.trim() ? { secret } : {}) })
        : await sendJSON<JSONRecord>("admin", "/extensions", "POST", { name: name.trim(), url: address.trim(), secret });
      setSecret("");
      await onSaved(asRecord(saved));
    } catch (cause) {
      setFailure(storeRefusal(errorText(cause), editing));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form class="extension-form" aria-label={editing ? `Edit ${stringValue(extension?.name, "extension")}` : "Add extension"} onSubmit={submit}>
      <div class="extension-form__fields">
        <div class="field">
          <label for={nameID}>Name</label>
          <input id={nameID} value={name} autoComplete="off" aria-describedby={`${nameID}-help`} onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} />
          <p class="form-help" id={`${nameID}-help`}>Shown here and in request logs.</p>
        </div>
        <div class="field">
          <label for={addressID}>Address</label>
          <input id={addressID} class="technical" value={address} placeholder="http://127.0.0.1:18888" autoComplete="off" spellcheck={false} aria-describedby={`${addressID}-help`} onInput={(event) => { setAddress((event.currentTarget as HTMLInputElement).value); changed(); }} />
          <p class="form-help" id={`${addressID}-help`}>The URL the gateway reaches the daemon at. In Docker Compose, that is the daemon's service name.</p>
        </div>
        <div class="field">
          <label for={secretID}>Shared secret</label>
          <span class="input-group">
            <input id={secretID} type={shown ? "text" : "password"} value={secret} autoComplete="new-password" spellcheck={false} aria-describedby={`${secretID}-help`} onInput={(event) => { setSecret((event.currentTarget as HTMLInputElement).value); changed(); }} />
            <button class="icon-button" type="button" aria-label={shown ? "Hide the secret" : "Show the secret"} aria-pressed={shown} aria-controls={secretID} onClick={() => setShown(!shown)}>
              {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
          <p class="form-help" id={`${secretID}-help`}>
            The secret the daemon was started with, its <span class="technical">LLMGW_EXTENSION_SECRET</span>. Stored encrypted: you can replace it later, but not read it back.{editing ? " Leave it empty to keep the stored one." : ""}
          </p>
        </div>
      </div>
      {checked ? <CheckResult status={checked} address={address.trim()} minimumVersion={minimumVersion} /> : null}
      {checkError ? <MessageNotice message={checkError} /> : null}
      {failure ? <MessageNotice message={failure} icon={failure.title === "The secret can't be stored yet" ? Lock : undefined} /> : null}
      <footer class="panel-footer">
        <div class="provider-actions">
          <button class="button button--secondary" type="button" disabled={checking} onClick={() => void check()}>
            {checking ? <LoaderCircle class="spin" size={15} /> : <RefreshCw size={15} />} {checking ? "Checking…" : checked || checkError ? "Check again" : "Check connection"}
          </button>
        </div>
        <div class="provider-actions">
          <button class="button button--secondary" type="button" onClick={onCancel}>Cancel</button>
          <button class="button button--primary" type="submit" disabled={saving}>
            {saving ? <LoaderCircle class="spin" size={15} /> : null} {editing ? "Save changes" : "Add extension"}
          </button>
        </div>
      </footer>
    </form>
  );
}

// SetupTokenDialog stores the setup token a provider served through the
// companion daemon signs in to Anthropic with, as the gateway's own.
export function SetupTokenDialog({ providerID, label, onClose, onSaved }: { providerID: string; label: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useDialogFocus(onClose);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (!token.trim()) {
      setError("Paste the setup token first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await sendJSON<JSONRecord>("admin", "/providers", "POST", { id: providerID, type: "anthropic_setup_token", api_key: token, credential_kind: "setup_token" });
      setToken("");
      await onSaved();
      onClose();
    } catch (cause) {
      setToken("");
      setError(errorText(cause, "The setup token was not stored."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="dialog-backdrop" role="presentation">
      <section ref={dialogRef} class="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-token-title" tabIndex={-1}>
        <header>
          <div>
            <p class="eyebrow">Add token</p>
            <h2 id="setup-token-title">{label}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <form class="form-stack" onSubmit={submit}>
          <p class="muted-copy">The gateway sends <span class="technical">{providerID}</span>'s requests with this token, through the extension that serves it.</p>
          <label>
            Setup token
            <input type="password" value={token} autoComplete="off" onInput={(event) => setToken((event.currentTarget as HTMLInputElement).value)} />
          </label>
          <p class="form-help">The setup token is validated, encrypted, and never returned.</p>
          {error ? <p class="form-error" role="alert">{error}</p> : null}
          <footer>
            <button class="button button--secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button class="button button--primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle class="spin" size={16} /> : <ShieldCheck size={16} />} Save token
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

// A PanelNotice is a message about one extension, shown in its panel: what
// a check, a removal or an added provider came to.
type PanelNotice = { id: string; message: Message } | null;

// ExtensionShelf lists the extensions, first among the hub's shelves: each
// daemon with what it serves and whether it answers, and, open, its facts,
// what needs attention and the providers it serves, each with its state in
// this gateway and a next step. Under the hub's search and filter it shows
// what answers them and opens the first extension a match is in.
export function ExtensionShelf({ data, extensions, search, filter, onChanged, onAddAccount, onOpenDetail }: {
  data: JSONRecord;
  extensions: ExtensionsState;
  search: string;
  filter: string;
  onChanged: () => Promise<void>;
  onAddAccount: (registryID: string, providerID: string) => void;
  onOpenDetail: (entryID: string) => void;
}) {
  const [open, setOpen] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [tokenFor, setTokenFor] = useState<{ providerID: string; label: string } | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const { listing, loading, error, minimumVersion, legacyEnvironment } = extensions;
  const all = extensions.extensions;
  const needle = search.trim();
  const narrowing = Boolean(needle) || filter !== "all";
  const items = shelfItems(all, data, search, filter);
  const firstMatched = stringValue(items.find((item) => item.matched)?.extension.id);
  // A search or filter that finds a provider inside an extension opens it;
  // clearing them closes it, as the hub closes its own.
  const narrowKey = narrowing ? `${needle}|${filter}|${firstMatched}` : "";
  useEffect(() => {
    setOpen(narrowKey ? firstMatched : "");
  }, [narrowKey]);
  const openItem = items.find((item) => stringValue(item.extension.id) === open);
  const openExtension = openItem?.extension ?? {};
  const openID = stringValue(openExtension.id);

  // The gateway's state, and with it the listing, follows every change; a
  // state that does not reload leaves the listing to reload alone.
  const refresh = async () => {
    try {
      await onChanged();
    } catch {
      await extensions.reload();
    }
  };
  const focusTrigger = (key: string) => {
    const trigger = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-extension-trigger]") ?? []).find((button) => button.dataset.extensionTrigger === key);
    trigger?.focus();
    return Boolean(trigger);
  };
  // A row that a save or a removal brings or leaves takes the focus once it
  // renders, so the keyboard does not fall back to the top of the page.
  const pendingFocus = useRef("");
  useEffect(() => {
    if (pendingFocus.current && focusTrigger(pendingFocus.current)) pendingFocus.current = "";
  });
  const toggle = (id: string) => {
    setNotice(null);
    setEditing("");
    setAdding(false);
    setOpen(open === id ? "" : id);
  };
  const startAdding = () => {
    setNotice(null);
    setEditing("");
    setOpen("");
    setAdding(!adding);
  };

  const checkSaved = async (id: string) => {
    setBusy(`${id}-check`);
    setNotice(null);
    try {
      extensions.setStatus(id, asRecord(await sendJSON<JSONRecord>("admin", `/extensions/${encodeURIComponent(id)}/check`, "POST", {})));
    } catch (cause) {
      setNotice({ id, message: { tone: "error", title: "The check didn't run", detail: errorText(cause) } });
    } finally {
      setBusy("");
    }
  };

  const remove = async (extension: JSONRecord) => {
    const id = stringValue(extension.id);
    const name = stringValue(extension.name, id);
    if (!window.confirm(`Remove the extension ${name}? Its stored secret is deleted with it.`)) return;
    setBusy(`${id}-remove`);
    setNotice(null);
    try {
      await sendJSON<JSONRecord>("admin", `/extensions/${encodeURIComponent(id)}`, "DELETE");
      setOpen("");
      pendingFocus.current = "add";
      await refresh();
    } catch (cause) {
      const failure = asRecord(cause);
      const providers = asList(asRecord(failure.detail).providers).map((provider) => stringValue(provider)).filter(Boolean);
      setNotice({
        id,
        message: failure.status === 409 && providers.length
          ? { tone: "warning", title: `${name} is still in use, so it wasn't removed`, detail: removalReason(providers) }
          : { tone: "error", title: `${name} wasn't removed`, detail: errorText(cause) },
      });
      // A provider came to use it since the listing loaded.
      if (failure.status === 409) await refresh();
    } finally {
      setBusy("");
    }
  };

  // addServed creates the provider a row stands for, served by extension,
  // under an ID no configured provider has, then takes the next step it
  // needs: an account, a token, or nothing.
  const addServed = async (extension: JSONRecord, row: ServedRow) => {
    const extensionID = stringValue(extension.id);
    const providerID = freeProviderID(providerBaseID(row, data), asList(data.providers).map((provider) => stringValue(asRecord(provider).id)));
    setBusy(`${extensionID}-${row.type}-add`);
    setNotice(null);
    try {
      await sendJSON<JSONRecord>("admin", "/providers", "POST", addProviderBody(row, extensionID, providerID));
      await refresh();
      if (row.credential === "oauth" && row.registryID) onAddAccount(row.registryID, providerID);
      else if (row.credential === "token") setTokenFor({ providerID, label: row.label });
      else setNotice({ id: extensionID, message: { tone: "success", title: `${row.label} added`, detail: `It is configured as ${providerID}. Add it to a route to send requests to it.` } });
    } catch (cause) {
      setNotice({ id: extensionID, message: { tone: "error", title: `${row.label} wasn't added`, detail: errorText(cause) } });
    } finally {
      setBusy("");
    }
  };

  const columns: TableColumn<ServedRow>[] = [
    { id: "provider", header: "Provider", cell: (row) => <span class="provider-cell"><ProviderMark id={row.markID} label={row.label} />{row.label}</span> },
    { id: "serves", header: "Serves", cell: (row) => row.surfaces.length ? <span class="chip-row">{row.surfaces.map((surface) => <span class="surface-chip" key={surface}>{surfaceLabel(surface)}</span>)}</span> : "Not reported" },
    { id: "signin", header: "Sign-in", cell: (row) => row.signIn },
    { id: "state", header: "In this gateway", cell: (row) => <span class={`status-pill status-pill--${row.state.tone}`}>{row.state.label}</span> },
    {
      id: "actions", header: "Actions", headerCell: <span class="sr-only">Actions</span>, cell: (row) => {
        const adding = busy === `${openID}-${row.type}-add`;
        const needsToken = row.instances.find((instance) => stringValue(instance.status) === "needs_credentials") ?? row.instances[0];
        return (
          <div class="row-actions">
            {!row.state.added && row.addable ? (
              <button class="button button--secondary button--compact" type="button" aria-label={`Add ${row.label}`} disabled={Boolean(busy)} onClick={() => void addServed(openExtension, row)}>
                {adding ? <LoaderCircle class="spin" size={14} /> : <Plus size={14} />} Add
              </button>
            ) : null}
            {row.state.added && row.credential === "oauth" && row.registryID && row.instances.length === 1 ? (
              <button class="button button--secondary button--compact" type="button" aria-label={`Add account for ${row.label}`} onClick={() => onAddAccount(row.registryID, stringValue(row.instances[0].id))}>
                <Plug size={14} /> Add account
              </button>
            ) : null}
            {row.state.needs === "token" ? (
              <button class="button button--secondary button--compact" type="button" aria-label={`Add token for ${row.label}`} onClick={() => setTokenFor({ providerID: stringValue(needsToken?.id), label: row.label })}>
                <KeyRound size={14} /> Add token
              </button>
            ) : null}
            {row.state.added ? (
              <button class="provider-hub__detail-link" type="button" aria-label={`Open ${row.label} details`} onClick={() => onOpenDetail(row.registryID || stringValue(row.instances[0].id))}>
                Details
              </button>
            ) : null}
          </div>
        );
      },
    },
  ];
  const servedView = useTableView(openItem?.rows ?? [], columns);

  const visible = adding || Boolean(editing) || shelfShows(extensions, data, search, filter);
  if (!visible) return null;

  const panel = (extension: JSONRecord) => {
    const id = stringValue(extension.id);
    const name = stringValue(extension.name, id);
    const status = asRecord(extension.status);
    const reachable = boolValue(status.reachable);
    const version = stringValue(status.version);
    const checkedAt = stringValue(status.checked_at);
    const inUse = asList(extension.providers).map((provider) => stringValue(asRecord(provider).id)).filter(Boolean);
    const effect = unreachableEffect(extension);
    if (editing === id) {
      return (
        <article class="extension-panel" id={`extension-panel-${id}`} aria-label={name} key={`${id}-panel`}>
          <ExtensionForm
            extension={extension}
            minimumVersion={minimumVersion}
            onCancel={() => {
              setEditing("");
              focusTrigger(id);
            }}
            onSaved={async () => {
              setEditing("");
              await refresh();
              focusTrigger(id);
            }}
          />
        </article>
      );
    }
    return (
      <article class="extension-panel" id={`extension-panel-${id}`} aria-label={name} key={`${id}-panel`}>
        <dl class="extension-facts">
          <div><dt>Address</dt><dd class="technical">{stringValue(extension.url)}</dd></div>
          <div><dt>Shared secret</dt><dd>{boolValue(extension.secret_set) ? "Set · stored encrypted" : "Not set"}</dd></div>
          <div><dt>Version</dt><dd>{version ? `llmgw-extension ${version}` : "Not reported"}</dd></div>
          {reachable && boolValue(status.outdated) ? <div><dt>This gateway expects</dt><dd>{minimumVersion} or later</dd></div> : null}
          <div><dt>Answered in</dt><dd>{answeredIn(status)}</dd></div>
          <div><dt>Last checked</dt><dd>{checkedAt && Number.isFinite(Date.parse(checkedAt)) ? new Date(Date.parse(checkedAt)).toLocaleString() : "Not checked"}</dd></div>
          {stringValue(status.error) ? <div class="extension-facts__wide"><dt>Error</dt><dd class="technical">{stringValue(status.error)}</dd></div> : null}
        </dl>
        {reachable && boolValue(status.unauthenticated) ? <MessageNotice message={unauthenticatedWarning} icon={Lock} /> : null}
        {reachable && boolValue(status.outdated) ? <MessageNotice message={outdatedWarning(version, minimumVersion)} /> : null}
        {effect ? (
          <div class="notice notice--warning" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <strong>
                {joinNames<ComponentChildren>(effect.providers.map((provider) => <span class="technical" key={provider}>{provider}</span>), " and ", ", ")}
                {" can't serve requests"}
              </strong>
              <p>{effect.detail}</p>
            </div>
          </div>
        ) : null}
        <div>
          <h3 class="panel-subhead">Providers it serves {servedView.total ? <span>Add one to use it in routes. Accounts are signed in per person.</span> : null}</h3>
          {servedView.total ? dataTable(servedView, columns, { label: `Providers ${name} serves`, rowKey: (row) => row.type, class: "served-table" }) : <p class="form-help">The daemon hasn't said what it serves, and no provider uses this extension yet. Check it once it runs.</p>}
        </div>
        {notice?.id === id ? <MessageNotice message={notice.message} /> : null}
        <footer class="panel-footer">
          <div class="provider-actions">
            <button class="button button--secondary" type="button" disabled={busy === `${id}-check`} onClick={() => void checkSaved(id)}>
              {busy === `${id}-check` ? <LoaderCircle class="spin" size={15} /> : <RefreshCw size={15} />} Check now
            </button>
            <button class="button button--secondary" type="button" onClick={() => { setNotice(null); setEditing(id); }}>
              <Pencil size={15} /> Edit
            </button>
            <button class="button button--danger" type="button" disabled={inUse.length > 0 || busy === `${id}-remove`} onClick={() => void remove(extension)}>
              {busy === `${id}-remove` ? <LoaderCircle class="spin" size={15} /> : <Trash2 size={15} />} Remove
            </button>
          </div>
          <DisabledReason reason={removalReason(inUse)} />
        </footer>
      </article>
    );
  };

  const addForm = (
    <article class="extension-panel" id="extension-add-panel" aria-label="Add extension">
      <ExtensionForm
        minimumVersion={minimumVersion}
        onCancel={() => {
          setAdding(false);
          focusTrigger("add");
        }}
        onSaved={async (saved) => {
          setAdding(false);
          pendingFocus.current = stringValue(saved.id);
          await refresh();
          setOpen(stringValue(saved.id));
        }}
      />
    </article>
  );

  return (
    <section
      class="provider-group extension-group"
      aria-labelledby="extensions-heading"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // A dialog took this Escape already; the hub must not take it too.
        if (event.defaultPrevented || tokenFor) {
          event.stopPropagation();
          return;
        }
        const key = editing || (adding ? "add" : open);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        setEditing("");
        setAdding(false);
        if (!editing) setOpen("");
        focusTrigger(key);
      }}
    >
      <header>
        <h2 id="extensions-heading">Extensions</h2>
        {listing ? <span>{all.length}</span> : null}
        <p class="provider-group__lede">Companion daemons that serve providers the gateway can't reach on its own.</p>
        {loading && listing ? <span class="extension-group__busy" role="status"><LoaderCircle class="spin" size={13} aria-hidden="true" /> Checking…</span> : null}
      </header>
      {legacyEnvironment ? <MessageNotice message={{ tone: "warning", title: "LLMGW_EXTENSION_URL and LLMGW_EXTENSION_SECRET are no longer read", detail: "The gateway's environment still sets them. Add the daemon here, then remove the variables." }} /> : null}
      {error ? (
        <MessageNotice message={{ tone: "error", title: "The extensions could not be loaded", detail: error }}>
          <div class="provider-actions">
            <button class="button button--secondary button--compact" type="button" onClick={() => void extensions.reload()}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        </MessageNotice>
      ) : null}
      <div class="extension-shelf">
        {!listing ? (
          error ? null : (
            <div class="extension-row extension-row--placeholder" role="status">
              <span class="provider-mark" aria-hidden="true"><LoaderCircle class="spin" size={18} /></span>
              <span>Checking extensions…</span>
            </div>
          )
        ) : !all.length && !adding ? (
          <div class="extension-empty">
            <span class="provider-mark" aria-hidden="true"><Server size={18} /></span>
            <div>
              <h3>No extension yet</h3>
              <p>An extension is a companion daemon that serves providers the gateway can't reach on its own. Run one, then add its address and shared secret here. It brings:</p>
              <ul class="unlock-list">
                {daemonTypes.map((known) => <li key={known.type}><ProviderMark id={known.markID} label={known.label} />{known.label}</li>)}
              </ul>
              <div class="provider-actions">
                <button class="button button--primary" type="button" data-extension-trigger="add" onClick={startAdding}>
                  <Plus size={15} /> Add extension
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {items.map(({ extension }) => {
              const id = stringValue(extension.id);
              const pill = extensionPill(extension.status);
              const version = stringValue(asRecord(extension.status).version);
              return [
                <button key={id} class={`extension-row ${open === id ? "extension-row--selected" : ""}`} type="button" data-extension-trigger={id} aria-expanded={open === id} aria-controls={`extension-panel-${id}`} onClick={() => toggle(id)}>
                  <span class="provider-mark" aria-hidden="true"><Server size={18} /></span>
                  <span class="extension-row__name"><strong>{stringValue(extension.name, id)}</strong><span class="technical">{stringValue(extension.url)}</span></span>
                  <span class="extension-row__served">{servedSummary(extension)}</span>
                  <span class="extension-row__version">{version || "—"}</span>
                  <span class={`status-pill status-pill--${pill.tone}`}>{pill.label}</span>
                  {open === id ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                </button>,
                open === id ? panel(extension) : null,
              ];
            })}
            <button class={`extension-row extension-row--add ${adding ? "extension-row--selected" : ""}`} type="button" data-extension-trigger="add" aria-expanded={adding} aria-controls="extension-add-panel" onClick={startAdding}>
              <span class="provider-mark" aria-hidden="true"><Plus size={16} /></span>
              <span>Add extension</span>
            </button>
          </>
        )}
        {adding ? addForm : null}
      </div>
      {tokenFor ? <SetupTokenDialog providerID={tokenFor.providerID} label={tokenFor.label} onClose={() => setTokenFor(null)} onSaved={refresh} /> : null}
    </section>
  );
}
