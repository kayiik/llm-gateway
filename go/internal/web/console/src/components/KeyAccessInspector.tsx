import { useEffect, useRef, useState } from "preact/hooks";
import { RefreshCw, X } from "lucide-preact";
import { getJSON, type JSONRecord } from "../lib/api";
import type { ConsoleMode } from "../lib/mode";
import { asList, asRecord, stringValue } from "../lib/records";
import { sentenceCase } from "../lib/text";

export function KeyAccessInspector({ keyID, keyName, mode, reload, onClose }: {
  keyID: string; keyName: string; mode: ConsoleMode; reload: number; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<JSONRecord | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const current = ++request.current;
    setSnapshot(null);
    setError("");
    getJSON<JSONRecord>(mode, `/keys/${encodeURIComponent(keyID)}/access`).then((result) => {
      if (current === request.current) setSnapshot(result);
    }).catch((cause) => {
      if (current === request.current) setError(cause instanceof Error ? cause.message : "Access could not load.");
    });
    return () => { request.current++; };
  }, [keyID, mode, reload, revision]);

  const rows = asList(snapshot?.data).map(asRecord);
  const routes = rows.filter((row) => row.owned_by === "endpoint");
  const models = rows.filter((row) => row.owned_by !== "endpoint");
  const matching = (items: JSONRecord[]) => items.filter((row) => stringValue(row.id).toLowerCase().includes(query.trim().toLowerCase()));
  const visibleRoutes = matching(routes);
  const visibleModels = matching(models);
  const status = stringValue(snapshot?.status);

  return <section class="surface key-access" aria-label={`Effective access for ${keyName}`}>
    <header><div><h2>Current access · {keyName}</h2><p class="form-help">Computed from this key, its project rules, credential eligibility and the cached model catalog. Refresh after changing connections or policies. No provider request is sent.</p></div>
      <div class="key-access__actions"><button class="button button--secondary" type="button" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /> Refresh</button><button class="icon-button" type="button" aria-label="Close access inspector" onClick={onClose}><X size={17} /></button></div>
    </header>
    {error ? <p role="alert" class="form-error">{error} Select Refresh to try again.</p> : null}
    {!error && !snapshot ? <p role="status" class="muted-copy">Loading current access…</p> : null}
    {snapshot ? <>
      <p class="key-access__status"><span class={`status-pill ${status === "active" ? "status-pill--ready" : status === "disabled" ? "status-pill--muted" : "status-pill--attention"}`}>{sentenceCase(status)}</span> {sentenceCase(stringValue(snapshot.principal_kind))} key · {routes.length} route{routes.length === 1 ? "" : "s"} · {models.length} direct model{models.length === 1 ? "" : "s"}</p>
      {status !== "active" ? <p class="form-help">This key cannot make requests while it is {status === "unavailable" ? "missing an active owner, project or membership" : status}.</p> : rows.length === 0 ? <p class="form-help">No callable routes or direct models are available under the current policy and cached catalog.</p> : <>
        <label class="key-access__search">Find a route or model<input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Filter by name" /></label>
        <div class="key-access__groups"><div><h3>Routes</h3><p class="form-help">Members are shown in failover order after key, project and credential filters.</p>
          {visibleRoutes.length ? <ul>{visibleRoutes.slice(0, 40).map((route) => <li key={stringValue(route.id)}><strong class="technical">{stringValue(route.id)}</strong><span>{asList(route.failover).map((member) => { const target = asRecord(member); return `${stringValue(target.provider)}/${stringValue(target.model)}`; }).join(" → ")}</span></li>)}</ul> : <p class="form-help">No matching routes.</p>}
          {visibleRoutes.length > 40 ? <p class="form-help">Showing 40 of {visibleRoutes.length} matching routes. Filter to narrow the list.</p> : null}</div>
          <div><h3>Direct models</h3><p class="form-help">These names are eligible for direct calls. API ingress and any conversion are checked when a request is made.</p>
            {visibleModels.length ? <ul>{visibleModels.slice(0, 40).map((model) => <li key={stringValue(model.id)} class="technical">{stringValue(model.id)}</li>)}</ul> : <p class="form-help">No matching direct models.</p>}
            {visibleModels.length > 40 ? <p class="form-help">Showing 40 of {visibleModels.length} matching models. Filter to narrow the list.</p> : null}</div></div>
      </>}
      <p class="form-help">This is a catalog and policy snapshot. It does not test upstream availability, per-request API compatibility, or remaining quota.</p>
    </> : null}
  </section>;
}
