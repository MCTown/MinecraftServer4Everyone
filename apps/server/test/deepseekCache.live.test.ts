import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { appConfig } from "../src/config.js";
import { decryptSecret } from "../src/security/encrypt.js";
import { ModelService, type ChatMessageInput } from "../src/services/modelService.js";

/** Explicit opt-in: paid network requests, never use the user's saved gateway
 * credentials silently. Reports real provider usage, never simulated hits.
 */
test("LIVE DeepSeek warm append-only requests achieve >=90% aggregate input cache hits", {
  skip: process.env.DEEPSEEK_CACHE_LIVE !== "1" ? "Set DEEPSEEK_CACHE_LIVE=1 and credentials (or DEEPSEEK_CACHE_USE_SAVED=1) for paid verification" : false,
  timeout: 240000
}, async (t) => {
  let saved: { base_url: string; model_name: string; encrypted_api_key: string; api_type: string } | undefined;
  if (process.env.DEEPSEEK_CACHE_USE_SAVED === "1") {
    // Read-only: do not initialize/migrate the application's live database or
    // run startup recovery merely to obtain the explicitly authorized settings.
    const db = new Database(appConfig.databasePath, { readonly: true });
    try {
      saved = db.prepare("SELECT base_url, model_name, encrypted_api_key, api_type FROM model_configs ORDER BY is_default DESC LIMIT 1").get() as typeof saved;
      assert.ok(saved, "No saved model configuration");
    } finally { db.close(); }
  }
  const apiKey = saved ? decryptSecret(saved.encrypted_api_key) : process.env.DEEPSEEK_API_KEY;
  assert.ok(apiKey, "DEEPSEEK_API_KEY is required");
  const model = new ModelService();
  const baseUrl = saved?.base_url || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const modelName = process.env.DEEPSEEK_MODEL || saved?.model_name || "deepseek-flash";
  assert.ok(!saved || saved.api_type === "chat_completions", "This benchmark requires Chat Completions for reasoning replay");
  console.log(JSON.stringify({ host: new URL(baseUrl).hostname, model: modelName, savedConfiguration: Boolean(saved) }));
  if (process.env.DEEPSEEK_CACHE_DIAGNOSTICS === "1") {
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      const copy = response.clone();
      void copy.text().then((text) => {
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5));
            const usage = event.usage ?? event.message?.usage;
            if (usage) console.log(JSON.stringify({ upstreamUsage: usage }));
          } catch { /* SSE terminator */ }
        }
      }).catch(() => {});
      return response;
    });
  }
  const tools = [{ type: "function" as const, function: { name: "read_status", description: "Read server status only when requested.", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }];
  const messages: ChatMessageInput[] = [{ role: "system", content: "This is a cache regression check. Do not call tools. Reply only OK.\n" +
    Array.from({ length: 2048 }, (_, index) => `Reference ${index}: Minecraft server files belong in server/; inspect results before acting.\n`).join("") },
    { role: "user", content: "Reply only OK." }];
  let hit = 0;
  let total = 0;
  let validUsage = true;
  for (let step = 0; step < 4; step++) {
    const response = await model.chatCompletionStream({ baseUrl, apiKey, modelName, messages,
      // Diagnostic only: this does not certify the agent's function-tool path.
      tools: process.env.DEEPSEEK_CACHE_NO_TOOLS === "1" ? undefined : tools, reasoningEffort: "minimal",
      signal: AbortSignal.timeout(55000) }, () => {});
    assert.equal(response.toolCalls.length, 0);
    const usage = response.usage;
    console.log(JSON.stringify({ step, usage, toolsEnabled: process.env.DEEPSEEK_CACHE_NO_TOOLS !== "1" }));
    const valid = Boolean(usage && typeof usage.cacheHitTokens === "number" &&
      usage.cacheHitTokens <= usage.promptTokens && (usage.cacheMissTokens === undefined ||
        usage.cacheHitTokens + usage.cacheMissTokens === usage.promptTokens));
    validUsage &&= valid;
    if (step > 0 && valid && usage) { hit += usage.cacheHitTokens!; total += usage.promptTokens; }
    messages.push({ role: "assistant", content: response.replayContent ?? response.content,
      reasoning_content: response.replayReasoning ?? response.reasoning });
    messages.push({ role: "user", content: `Runtime snapshot ${step}: stopped. Reply only OK.` });
    // Cache population is asynchronous on the provider. This is not a retry
    // that hides misses: all three warm measurements count toward the gate.
    if (step < 3) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert.ok(validUsage, "Provider usage is missing or inconsistent (cached tokens exceed total input); cannot certify cache hit ratio");
  console.log(JSON.stringify({ warmCacheHitRatio: hit / total, threshold: 0.9 }));
  assert.ok(total > 0 && hit / total >= 0.9, `Measured warm hit ratio ${hit / total} is below 90%`);
});
