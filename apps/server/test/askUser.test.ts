import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionBroker } from "../src/agent/questionBroker.js";
import { createAskUserTool, questionInputSchema } from "../src/agent/tools/askUserTool.js";
import { createGlobalAgentTools } from "../src/agent/tools/globalTools.js";
import { createAgentTools } from "../src/agent/tools.js";
import type { AgentToolContext } from "../src/agent/toolKit.js";

const input = { question: "选择部署方式", multiple: false, options: [{ label: "原版", description: "不安装模组" }, { label: "Fabric" }] };

test("single choice waits, validates scope/id/options and accepts exactly one answer", async () => {
  const broker = new QuestionBroker();
  const controller = new AbortController();
  const promise = broker.ask("instance-a", input, controller.signal);
  const question = broker.get("instance-a")!;
  assert.equal(question.question, input.question);
  assert.equal(broker.get("instance-b"), null);
  assert.throws(() => broker.answer("instance-b", question.id, ["原版"]));
  assert.throws(() => broker.answer("instance-a", "stale", ["原版"]));
  for (const selected of [[], ["未知"], ["原版", "Fabric"], ["原版", "原版"]]) {
    assert.throws(() => broker.answer("instance-a", question.id, selected));
  }
  broker.answer("instance-a", question.id, ["Fabric"]);
  assert.deepEqual(await promise, { status: "answered", selected: ["Fabric"] });
  assert.equal(broker.get("instance-a"), null);
  assert.throws(() => broker.answer("instance-a", question.id, ["Fabric"]));
});

test("multi choice returns all selected labels; cancel and abort never invent choices", async () => {
  const broker = new QuestionBroker();
  const controller = new AbortController();
  const promise = broker.ask("global", { ...input, multiple: true }, controller.signal);
  assert.throws(() => broker.ask("global", input, controller.signal));
  broker.answer("global", broker.get("global")!.id, ["原版", "Fabric"]);
  assert.deepEqual(await promise, { status: "answered", selected: ["原版", "Fabric"] });
  const cancelled = broker.ask("global", input, controller.signal);
  broker.answer("global", broker.get("global")!.id, ["原版"], true);
  assert.deepEqual(await cancelled, { status: "cancelled", selected: [] });
  const aborted = broker.ask("global", input, controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { status: "cancelled", selected: [] });
  assert.equal(broker.get("global"), null);
  assert.deepEqual(await broker.ask("global", input, controller.signal), { status: "cancelled", selected: [] });
});

test("question remains answerable after a long browser absence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const broker = new QuestionBroker();
  const promise = broker.ask("global", input, new AbortController().signal);
  t.mock.timers.tick(10 * 60 * 1000);
  const question = broker.get("global")!;
  assert.ok(question);
  broker.answer("global", question.id, ["Fabric"]);
  assert.deepEqual(await promise, { status: "answered", selected: ["Fabric"] });
  assert.equal(broker.get("global"), null);
});

test("tool validates model input and is available in both conversation scopes", async () => {
  assert.equal(questionInputSchema.parse({ question: "test", options: input.options }).multiple, false);
  for (const invalid of [
    { ...input, question: " " }, { ...input, options: [input.options[0]] },
    { ...input, options: [input.options[0], input.options[0]] }, { ...input, multiple: "yes" }
  ]) assert.equal(questionInputSchema.safeParse(invalid).success, false);
  let called = false;
  const context = { getServerId: () => "test", askUser: async (question) => {
    called = true;
    assert.deepEqual(question, input);
    return { status: "answered", selected: ["Fabric"] };
  } } as AgentToolContext;
  const output = await createAskUserTool(context).execute(input);
  assert.equal(called, true);
  assert.deepEqual(JSON.parse(output), { status: "answered", selected: ["Fabric"] });
  assert.ok(createAgentTools(context).some((tool) => tool.definition.function.name === "ask_user"));
  assert.ok(!createAgentTools({ ...context, allowAskUser: false }).some((tool) => tool.definition.function.name === "ask_user"));
  assert.ok(createGlobalAgentTools(context.serverService, context.processManager, {} as never, context).some((tool) => tool.definition.function.name === "ask_user"));
});
