import assert from "node:assert/strict";
import test from "node:test";
import { ModelService } from "../src/services/modelService.js";

const base = { baseUrl: "http://model.test/v1", modelName: "test", apiKey: "test-key" };

test("listAvailableModels uses the saved config and returns ids", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [
      { id: "gpt-4o-mini", object: "model" },
      { id: "gpt-4o", object: "model" },
      { id: "gpt-4o" }
    ] }), { headers: { "content-type": "application/json" } });
  });
  const models = await new ModelService().listAvailableModels({ baseUrl: "http://model.test/v1", apiKey: "k" });
  assert.deepEqual(models.models, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(calls[0], "http://model.test/v1/models");
});

test("listAvailableModels surfaces provider errors instead of empty success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401, headers: { "content-type": "application/json" } }));
  await assert.rejects(new ModelService().listAvailableModels({ baseUrl: "http://model.test/v1", apiKey: "bad" }), /invalid key/);
});

test("listAvailableModels retries a root URL with the OpenAI /v1 prefix", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { headers: { "content-type": "application/json" } });
  });

  const result = await new ModelService().listAvailableModels({ baseUrl: "http://model.test", apiKey: "test-key" });
  assert.deepEqual(result.models, ["gpt-5"]);
  assert.deepEqual(calls, ["http://model.test/models", "http://model.test/v1/models"]);
});

test("responses api maps chat messages into instructions, input and function tools", async (t) => {
  let captured: { url: string; body: {
    instructions?: string;
    input?: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
    model?: string;
  } } | null = null;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "先思考 " }] },
        { type: "function_call", call_id: "call_1", name: "list_server_files", arguments: "{\"path\":\".\"}" }
      ],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
    }), { headers: { "content-type": "application/json" } });
  });

  const result = await new ModelService().chatCompletionResult({
    ...base,
    apiType: "responses",
    temperature: 0,
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "看看目录" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "list_server_files", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "call_0" }
    ],
    tools: [{ type: "function", function: { name: "list_server_files", description: "list", parameters: { type: "object" } } }]
  });

  assert.equal(captured!.url, "http://model.test/v1/responses");
  assert.equal(captured!.body.instructions, "你是助手");
  assert.equal(captured!.body.tools?.[0]?.type, "function");
  assert.equal(captured!.body.tools?.[0]?.name, "list_server_files");
  assert.ok(!("function" in (captured!.body.tools?.[0] ?? {})));
  const input = captured!.body.input ?? [];
  assert.deepEqual(input.filter((item) => item.role === "user"), [{ role: "user", content: "看看目录" }]);
  assert.deepEqual(input.find((item) => item.type === "function_call"), { type: "function_call", call_id: "call_0", name: "list_server_files", arguments: "{}" });
  assert.deepEqual(input.find((item) => item.type === "function_call_output"), { type: "function_call_output", call_id: "call_0", output: "ok" });

  assert.equal(result.toolCalls[0]?.function.name, "list_server_files");
  assert.equal(result.toolCalls[0]?.id, "call_1");
  assert.equal(result.reasoning, "先思考");
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
});

test("responses streaming assembles text, reasoning and function call arguments", async (t) => {
  const encoder = new TextEncoder();
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "run_shell_command", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "call_1", delta: "{\"command\":" },
    { type: "response.function_call_arguments.delta", item_id: "call_1", delta: "\"ls\"}" },
    { type: "response.reasoning_summary_text.delta", delta: "先检查 " },
    { type: "response.output_text.delta", delta: "好的" },
    { type: "response.output_text.delta", delta: "，执行中" },
    { type: "response.completed", response: { output: [{ type: "function_call", call_id: "call_1", name: "run_shell_command", arguments: "{\"command\":\"ls\"}" }] } }
  ];
  const stream = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = encoder.encode(stream);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 11) controller.enqueue(bytes.slice(index, index + 11));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));

  const text: string[] = [];
  const reasoning: string[] = [];
  const result = await new ModelService().chatCompletionStream(
    { ...base, apiType: "responses", messages: [{ role: "user", content: "执行" }] },
    (delta) => text.push(delta),
    (delta) => reasoning.push(delta)
  );

  assert.equal(reasoning.join(""), "先检查 ");
  assert.equal(text.join(""), "好的，执行中");
  assert.equal(result.content, "好的，执行中");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.function.name, "run_shell_command");
  assert.equal(result.toolCalls[0]?.function.arguments, "{\"command\":\"ls\"}");
});
