import { routeIngressOptions, type RouteContract } from "../lib/routes";

export function RouteContractFields({ value, onChange, disabled }: {
  value: RouteContract;
  onChange: (value: RouteContract) => void;
  disabled?: boolean;
}) {
  const select = (path: string, checked: boolean) => {
    const ingress = checked ? [...value.ingress, path] : value.ingress.filter((current) => current !== path);
    onChange({ ingress, allow_adaptation: ingress.length > 0 && value.allow_adaptation });
  };
  const option = ({ path, label }: { path: string; label: string }) => <label class="route-contract__option" key={path}>
    <input type="checkbox" checked={value.ingress.includes(path)} disabled={disabled} onChange={(event) => select(path, event.currentTarget.checked)} />
    <span>{label}</span>
  </label>;
  const otherSelected = value.ingress.some((path) => routeIngressOptions.slice(3).some((entry) => entry.path === path));
  const unlisted = value.ingress.filter((path) => !routeIngressOptions.some((entry) => entry.path === path));
  return <fieldset class="route-contract" aria-describedby="route-ingress-help" disabled={disabled}>
    <legend>Accepted client APIs</legend>
    <p class="form-help" id="route-ingress-help">No selection accepts any matching native API. Selecting APIs restricts this route to those entrypoints.</p>
    <div class="route-contract__choices">{routeIngressOptions.slice(0, 3).map(option)}</div>
    <details class="route-contract__other" open={otherSelected}>
      <summary>Other inference APIs</summary>
      <div class="route-contract__choices">{routeIngressOptions.slice(3).map(option)}</div>
    </details>
    {unlisted.length ? <p class="form-help">Other declared APIs: {unlisted.join(", ")}.</p> : null}
    <label class="route-contract__adaptation">
      <input type="checkbox" checked={value.allow_adaptation} disabled={disabled || (!value.ingress.length && !value.allow_adaptation)} onChange={(event) => onChange({ ...value, allow_adaptation: event.currentTarget.checked })} aria-describedby="route-adaptation-help" />
      <span>Allow compatible mappings</span>
    </label>
    <p class="form-help" id="route-adaptation-help">{!value.ingress.length
      ? "Select an accepted API to enable adaptation. Without it, members must serve the request's actual native API."
      : value.allow_adaptation
        ? "Only reviewed mappings for the selected APIs are permitted. Unsupported content, constraints and state are still refused; requests can disable adaptation."
        : "Native only: members must serve the selected API without adaptation."}</p>
  </fieldset>;
}
