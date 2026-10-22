import { useState } from "preact/hooks";
import { Plus, Save, Trash2 } from "lucide-preact";
import { sendJSON, type JSONRecord } from "../../lib/api";
import { asRecord, stringValue } from "../../lib/records";

const fields = [["rpm", "Requests per minute"], ["daily_tokens", "Daily tokens"], ["monthly_tokens", "Monthly tokens"]] as const;
type Values = Record<typeof fields[number][0], string>;
type ModelRow = { name: string; values: Values };

function valuesOf(raw: unknown): Values {
  const record = asRecord(raw);
  return Object.fromEntries(fields.map(([field]) => [field, typeof record[field] === "number" && record[field] !== 0 ? String(record[field]) : ""])) as Values;
}

export function limitValues(values: Values): JSONRecord {
  const result: JSONRecord = {};
  for (const [field, label] of fields) {
    const raw = values[field].trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`${label} must be a non-negative whole number.`);
    if (value > 0) result[field] = value;
  }
  return result;
}

export function ProviderUsageLimits({ provider, onSaved }: { provider: JSONRecord; onSaved: () => Promise<void> }) {
  const id = stringValue(provider.id);
  const initial = asRecord(provider.usage_limits);
  const [aggregate, setAggregate] = useState<Values>(() => valuesOf(initial));
  const [models, setModels] = useState<ModelRow[]>(() => Object.entries(asRecord(initial.models)).map(([name, limits]) => ({ name, values: valuesOf(limits) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = () => { setError(""); setSaved(false); };
  const save = async (event: Event) => {
    event.preventDefault();
    changed();
    try {
      const limits = limitValues(aggregate);
      const modelLimits: JSONRecord = Object.create(null) as JSONRecord;
      for (const row of models) {
        const name = row.name.trim();
        if (!name) throw new Error("Enter the exact upstream model ID or remove the empty row.");
        if (Object.hasOwn(modelLimits, name)) throw new Error(`Model ${name} is listed twice.`);
        modelLimits[name] = limitValues(row.values);
      }
      if (models.length) limits.models = modelLimits;
      setBusy(true);
      await sendJSON("admin", `/providers/${encodeURIComponent(id)}/usage-limits`, "PATCH", { usage_limits: limits });
      await onSaved();
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Limits could not be saved. Try again.");
    } finally { setBusy(false); }
  };
  const inputs = (values: Values, update: (next: Values) => void, scope: string) => fields.map(([field, label]) => <label class="field" key={field}>{label}<input aria-label={`${scope} ${label.toLowerCase()}`} type="number" min="0" step="1" max={Number.MAX_SAFE_INTEGER} value={values[field]} placeholder="Unlimited" onInput={(event) => { changed(); update({ ...values, [field]: (event.currentTarget as HTMLInputElement).value }); }} /></label>);
  return <details class="surface provider-usage-limits">
    <summary>Usage limits · <span class="technical">{id}</span></summary>
    <form onSubmit={save} aria-label={`Usage limits for ${id}`}>
      <p class="muted-copy">Gateway-enforced limits across all accounts using this provider. Exact-model limits apply in addition to the provider total. Blank or zero means unlimited.</p>
      <div class="provider-limit-fields">{inputs(aggregate, setAggregate, "Provider")}</div>
      <h3>Exact-model limits</h3>
      {models.map((row, index) => <div class="provider-model-limit" key={index}>
        <label class="field">Upstream model ID<input aria-label={`Model ${index + 1} ID`} class="technical" value={row.name} placeholder="Exact upstream model ID" onInput={(event) => { changed(); setModels(models.map((current, i) => i === index ? { ...current, name: (event.currentTarget as HTMLInputElement).value } : current)); }} /></label>
        <div class="provider-limit-fields">{inputs(row.values, (values) => setModels(models.map((current, i) => i === index ? { ...current, values } : current)), `Model ${index + 1}`)}</div>
        <button class="button button--secondary" type="button" aria-label={`Remove model limit ${row.name || index + 1}`} onClick={() => { changed(); setModels(models.filter((_, i) => i !== index)); }}><Trash2 size={14} /> Remove model</button>
      </div>)}
      <button class="button button--secondary" type="button" onClick={() => { changed(); setModels([...models, { name: "", values: valuesOf({}) }]); }}><Plus size={14} /> Add model limit</button>
      <p class="form-help">UTC minute, day and month windows. Token thresholds use observed upstream usage; in-flight requests can exceed a threshold. These limits cover prepared Chat, Responses and Messages calls, including their retries; legacy media and realtime paths are not covered.</p>
      {error ? <p class="form-error" role="alert">{error}</p> : null}
      {saved ? <p role="status">Limits saved.</p> : null}
      <footer class="panel-footer"><button class="button button--primary" type="submit" disabled={busy}><Save size={15} /> {busy ? "Saving…" : "Save usage limits"}</button></footer>
    </form>
  </details>;
}
