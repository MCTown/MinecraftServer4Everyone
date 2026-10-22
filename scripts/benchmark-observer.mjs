// Loaded only in an isolated experiment backend. Observes the existing owned child.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { eventBus } from "../apps/server/src/services/eventBus.ts";
import { ProcessManager } from "../apps/server/src/services/processManager.ts";

const destination = process.env.BENCH_RESULT_DIR;
if (!destination || process.env.APP_PORT === "1143" || !process.env.WORKSPACE_ROOT?.startsWith("/tmp/opencode/benchmark-suite-20261021/")) {
  throw new Error("Owned process observer is restricted to isolated benchmark workspaces");
}
const save = (name, data) => appendFileSync(path.join(destination, name), JSON.stringify(data) + "\n", { mode: 0o600 });
eventBus.on("managedConsole", ({ launchId, entry }) => {
  save("owned-process-output.jsonl", { launchId, ...entry });
});
const originalStart = ProcessManager.prototype.start;
ProcessManager.prototype.start = async function (...args) {
  const result = await originalStart.apply(this, args);
  save("owned-launches.jsonl", { serverId: args[0], observedAt: new Date().toISOString(), ...this.getLaunchIdentity(args[0]) });
  return result;
};
