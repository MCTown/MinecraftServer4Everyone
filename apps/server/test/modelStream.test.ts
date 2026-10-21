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

test("DeepSeek streaming preserves exact replay and provider cache hit/miss usage", async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response([
      { choices: [{ delta: { reasoning_content: " think \n", content: " OK \n" } }] },
      { choices: [], usage: { prompt_tokens: 10000, completion_tokens: 12, total_tokens: 10012,
        prompt_cache_hit_tokens: 9856, prompt_cache_miss_tokens: 144 } }
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  const messages = [{ role: "assistant" as const, content: " previous ", reasoning_content: " prior thought \n" },
    { role: "user" as const, content: "continue" }];
  const response = await new ModelService().chatCompletionStream({ ...input, modelName: "deepseek-flash", messages }, () => {});
  assert.deepEqual(body.messages, messages);
  assert.equal(response.replayContent, " OK \n");
  assert.equal(response.replayReasoning, " think \n");
  assert.deepEqual(response.usage, { promptTokens: 10000, completionTokens: 12, totalTokens: 10012,
    cacheHitTokens: 9856, cacheMissTokens: 144 });
});

test("non-DeepSeek routes omit DeepSeek-only reasoning fields without mutating stored history", async (t) => {
  let body: { messages: Array<Record<string, unknown>> };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80 } } }));
  });
  const messages = [{ role: "assistant" as const, content: "ok", reasoning_content: "reasoning" }];
  const response = await new ModelService().chatCompletionResult({ ...input, messages });
  assert.ok(!("reasoning_content" in body!.messages[0]!));
  assert.equal(messages[0]!.reasoning_content, "reasoning");
  assert.equal(response.usage?.cacheHitTokens, 80);
});
