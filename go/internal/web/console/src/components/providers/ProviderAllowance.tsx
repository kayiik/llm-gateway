import { useEffect, useState } from "preact/hooks";
import { RefreshCw } from "lucide-preact";
import { getJSON, sendJSON, type JSONRecord } from "../../lib/api";
import type { ConsoleMode } from "../../lib/mode";
import { asList, asRecord, stringValue } from "../../lib/records";

export function allowanceValue(dimension: JSONRecord): string {
  if (typeof dimension.remaining !== "number" || !Number.isFinite(dimension.remaining)) return "Unknown";
  if (dimension.unit === "fraction") return `${Number((dimension.remaining * 100).toFixed(2))}% remaining`;
  return `${dimension.remaining.toLocaleString()} ${stringValue(dimension.unit)} remaining`;
}

export function ProviderAllowance({ connections, providerIDs, mode }: { connections: JSONRecord[]; providerIDs: string[]; mode: ConsoleMode }) {
  const [advisories, setAdvisories] = useState<JSONRecord[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const key = providerIDs.join("\n");
  const load = async () => {
    const report = await getJSON<JSONRecord>(mode, "/usage");
    setAdvisories(asList(report.quota_advisories).map(asRecord).filter((item) => providerIDs.includes(stringValue(item.provider_id))));
  };
  useEffect(() => { void load().catch(() => setError("Saved allowance data could not load. You can retry below.")); }, [mode, key]);
  const refresh = async (connection: JSONRecord) => {
    setBusy(stringValue(connection.id)); setError(""); setNotice("");
    try {
      const response = await sendJSON<JSONRecord>(mode, `/connections/${encodeURIComponent(stringValue(connection.id))}/quota/refresh`, "POST", {});
      const status = stringValue(response.status, "unknown");
      setNotice(status === "observed" ? "Provider observation refreshed. It is advisory, not a Gateway token balance." : status === "unsupported" ? "This provider does not expose a supported allowance reader. Gateway limits still work." : "The provider did not supply usable allowance data. Gateway limits and inference are unaffected.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Allowance could not refresh. Try again."); }
    finally { setBusy(""); }
  };
  const dimensions: JSONRecord[] = advisories.flatMap((advisory) => asList(advisory.dimensions).map(asRecord));
  return <section class="surface provider-allowance" aria-label="Upstream allowance">
    <div class="section-heading"><h2>Upstream allowance</h2><span class="status-pill status-pill--muted">Advisory only</span></div>
    <p class="muted-copy">Optional, provider-reported account observations. Refresh checks the control-plane API, not inference. Missing or unsupported data stays unknown; the Gateway enforces its own usage limits separately.</p>
    <div class="provider-actions">{connections.filter((item) => stringValue(item.status, "active") === "active").map((connection) => <button key={stringValue(connection.id)} class="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh(connection)}><RefreshCw size={15} class={busy === stringValue(connection.id) ? "spin" : ""} /> Refresh allowance · {stringValue(connection.connection_name, stringValue(connection.provider_id))}</button>)}</div>
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p class="form-error" role="alert">{error}</p> : null}
    {advisories.some((item) => item.status === "stale") ? <p class="form-help">Previous allowance data is stale. Refresh to request a current observation.</p> : null}
    {dimensions.length ? <div class="table-wrap"><table><thead><tr><th>Model / pool</th><th>Reported remaining</th><th>Evidence</th><th>Observed</th><th>Resets</th></tr></thead><tbody>{dimensions.map((dimension, index) => <tr key={index}><td class="technical">{stringValue(dimension.label, stringValue(dimension.metric))}</td><td>{allowanceValue(dimension)}</td><td>{dimension.confidence === "unknown" ? "Best effort · unverified" : stringValue(dimension.confidence, "Unknown")}<small class="table-subtitle">{stringValue(dimension.source)}</small></td><td>{stringValue(dimension.refreshed_at, "Unknown")}</td><td>{stringValue(dimension.reset_at, "Unknown")}</td></tr>)}</tbody></table></div> : <p class="form-help">No current model allowance observation. Unknown does not mean zero.</p>}
    {!connections.length ? <p class="form-help">Connect an account to refresh its upstream allowance.</p> : null}
  </section>;
}
