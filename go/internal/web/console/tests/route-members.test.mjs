import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/lib/routes.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
});
const routes = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

test("mixed route members preserve references, order and explicit publication opt-in", () => {
  const members = routes.routeMembers({ failover: [
    { provider: "first", model: "m", allow_unverified: true },
    { route: "shared" }, { provider: "last", model: "n" },
  ] });
  assert.deepEqual(members, [
    { provider: "first", model: "m", allow_unverified: true },
    { route: "shared" }, { provider: "last", model: "n" },
  ]);
  assert.equal(routes.routeMemberLabel(members[1]), "Route: shared");
  assert.notEqual(routes.routeMemberValue({ route: "model::m" }), routes.routeMemberValue({ provider: "route", model: "model::m" }));
});

test("saving a composed route submits source references and exposes nonblocking capability advice", async () => {
  let body;
  const message = await routes.commitRouteSave({ kind: "create", name: "composed" }, [{ route: "shared" }], "", async (_path, _method, saved) => {
    body = saved;
    return { warnings: ["Member 2 has different tools support."] };
  }, { ingress: ["/v1/chat/completions"], allow_adaptation: false });
  assert.deepEqual(body.failover, [{ route: "shared" }]);
  assert.match(message, /Route saved.*Warnings: Member 2 has different tools support\./);
});
