import assert from "node:assert/strict";
import test from "node:test";
import { ModelService } from "../src/services/modelService.js";

const input = { baseUrl: "http://model.test/v1", modelName: "test", apiKey: "test-key", messages: [{ role: "user" as const, content: "test" }] };

test("reasoning SSE deltas retain whitespace and UTF-8 across network chunk boundaries", async (t) => {
  const encoder = new TextEncoder();
  const stream = [
    { choices: [{ delta: { reasoning_content: "先检查 " } }] },
    { choices: [{ delta: { reasoning_content: "配置\n" } }] },
    { choices: [{ delta: { content: "回复 " } }] },
    { choices: [{ delta: { content: "完成" } }] }
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\n\n";
  const bytes = encoder.encode(stream);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  const text: string[] = [];
  const reasoning: string[] = [];
  const result = await new ModelService().chatCompletionStream(input, (delta) => text.push(delta), (delta) => reasoning.push(delta));
  assert.equal(reasoning.join(""), "先检查 配置\n");
  assert.equal(text.join(""), "回复 完成");
  assert.equal(result.reasoning, "先检查 配置");
});

test("provider errors inside an HTTP 200 SSE stream surface their actual reason", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('data: {"error":{"message":"quota exhausted","code":"insufficient_quota"}}\n\n'));
  await assert.rejects(new ModelService().chatCompletionStream(input, () => undefined), /quota exhausted/);
});
