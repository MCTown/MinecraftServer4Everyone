// Experiment-only prototype adapters; never loaded in the production backend.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { AgentService } from "../apps/server/src/agent/agentService.ts";
import { SkillService } from "../apps/server/src/services/skillService.ts";
import { profiles, transformPrompt, leanRuntime, compactStatic } from "./benchmark-ablation-transforms.mjs";

const profile = process.env.BENCH_ABLATION_PROFILE;
const root = process.env.WORKSPACE_ROOT;
if (!profiles.includes(profile) || process.env.APP_HOST !== "127.0.0.1" || process.env.APP_PORT === "1143" || !root?.startsWith("/tmp/opencode/benchmark-suite-20261021/ablation-")) {
  throw new Error("Ablation adapters require a dedicated isolated loopback backend");
}
const record = (event) => appendFileSync(path.join(process.env.BENCH_RESULT_DIR, "ablation-adapter.jsonl"), JSON.stringify({ at: new Date().toISOString(), profile, ...event }) + "\n", { mode: 0o600 });
record({ kind: "loaded" });
if (profile === "no-skill") SkillService.prototype.getEnabledSkillContents = async function () { return []; };
const compose = AgentService.prototype.composeSystemPrompt;
AgentService.prototype.composeSystemPrompt = function (prompt) {
  const full = compose.call(this, prompt);
  const output = profile === "compact-static" ? compactStatic(this.promptService.getDeploymentWorkflow()) : transformPrompt(full, profile);
  record({ kind: "system", beforeChars: full.length, afterChars: output.length });
  return output;
};
if (profile === "lean-runtime") {
  const runtime = AgentService.prototype.buildRuntimeContext;
  AgentService.prototype.buildRuntimeContext = async function (...args) {
    const original = await runtime.apply(this, args);
    return leanRuntime(original);
  };
}
if (profile === "no-progress" || profile === "single-turn") {
  const tools = AgentService.prototype.createTools;
  AgentService.prototype.createTools = function (...args) {
    return tools.apply(this, args).filter(tool => tool.definition.function.name !== (profile === "no-progress" ? "update_agent_workflow_progress" : "begin_deployment_workflow"));
  };
  const instruction = AgentService.prototype.workflowTurnInstruction;
  AgentService.prototype.workflowTurnInstruction = function (...args) { return transformPrompt(instruction.apply(this, args), profile); };
}
