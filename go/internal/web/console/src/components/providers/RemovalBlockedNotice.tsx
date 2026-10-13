import type { ComponentChildren } from "preact";
import { CircleAlert } from "lucide-preact";
import { connectionsInUseText, joinNames, type RemovalBlock } from "./shared";

// RemovalBlockedNotice says, where a provider's removal was refused, what
// still uses it and where to change each. connectionsHref opens the page
// that manages the connections; without it, onManageConnections does.
export function RemovalBlockedNotice({ block, label, connectionsHref, onManageConnections }: { block: RemovalBlock; label: string; connectionsHref?: string; onManageConnections?: () => void }) {
  const routes = block.endpoints;
  return (
    <div class="notice notice--warning" role="alert">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{label} is still in use, so it wasn't removed</strong>
        <ul>
          {routes.length ? (
            <li>
              <span>
                {routes.length === 1 ? "The route " : "The routes "}
                {joinNames<ComponentChildren>(routes.map((name) => <span class="technical" key={name}>{name}</span>), " and ", ", ")}
                {routes.length === 1 ? " sends requests to it." : " send requests to it."}
              </span>
              <a class="inline-link" href="#routes">Open Routes</a>
            </li>
          ) : null}
          {block.connections > 0 ? (
            <li>
              <span>{connectionsInUseText(block)}</span>
              {connectionsHref ? <a class="inline-link" href={connectionsHref}>Manage connections</a> : onManageConnections ? <button class="inline-link" type="button" onClick={onManageConnections}>Manage connections</button> : null}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
