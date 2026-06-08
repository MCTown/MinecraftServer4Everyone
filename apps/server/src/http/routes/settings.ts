import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { fetch } from "undici";
import { listAgentToolInfos } from "../../agent/toolCatalog.js";
import { fetchDispatcher } from "../../services/proxySupport.js";
import { idParams, parseBody } from "../helpers.js";
import type { RouteServices } from "../types.js";

function normalizeProxyTestTarget(rawTarget: string | undefined) {
  const trimmed = rawTarget?.trim() || "www.google.com";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("检测地址仅支持 HTTP 或 HTTPS");
  return url.href;
}

export function registerSettingsRoutes(app: FastifyInstance, services: RouteServices) {
  app.get("/api/models", async () => services.modelService.list());

  app.post("/api/models", async (request) => {
    const body = parseBody(z.object({
      displayName: z.string().min(1),
      baseUrl: z.string().min(1),
      modelName: z.string().min(1),
      apiKey: z.string().optional(),
      isDefault: z.boolean().default(false)
    }), request.body);
    return services.modelService.create(body);
  });

  app.patch("/api/models/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({
      displayName: z.string().optional(),
      baseUrl: z.string().optional(),
      modelName: z.string().optional(),
      apiKey: z.string().optional(),
      isDefault: z.boolean().optional()
    }), request.body);
    return services.modelService.update(id, body);
  });

  app.delete("/api/models/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    services.modelService.remove(id);
    return { ok: true };
  });

  app.post("/api/models/test", async (request) => {
    const body = parseBody(z.object({
      id: z.string().optional(),
      baseUrl: z.string().optional(),
      modelName: z.string().optional()
    }), request.body);
    return services.modelService.test(body);
  });

  app.get("/api/prompts/global", async () => ({ prompt: services.promptService.getGlobalPrompt() }));

  app.put("/api/prompts/global", async (request) => {
    const body = parseBody(z.object({ prompt: z.string() }), request.body);
    return { prompt: services.promptService.setGlobalPrompt(body.prompt) };
  });

  app.post("/api/prompts/global/reset", async () => ({ prompt: services.promptService.resetGlobalPrompt() }));

  const agentSettingsSchema = z.object({
    autoConfirm: z.boolean().optional(),
    downloadProxyEnabled: z.boolean().optional(),
    downloadProxyUrl: z.string().trim().optional(),
    memoryMb: z.number().optional()
  }).superRefine((body, context) => {
    if (!body.downloadProxyUrl) return;
    try {
      const url = new URL(body.downloadProxyUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["downloadProxyUrl"], message: "代理地址仅支持 HTTP 或 HTTPS" });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["downloadProxyUrl"], message: "代理地址格式无效" });
    }
  });

  app.get("/api/settings/agent", async () => services.promptService.getAgentSettings());

  app.put("/api/settings/agent", async (request) => {
    const body = parseBody(agentSettingsSchema, request.body);
    return services.promptService.setAgentSettings(body);
  });

  app.post("/api/settings/agent/proxy/test", async (request) => {
    const body = parseBody(z.object({
      target: z.string().trim().optional(),
      downloadProxyEnabled: z.boolean().optional(),
      downloadProxyUrl: z.string().trim().optional()
    }), request.body);
    const settings = services.promptService.getAgentSettings();
    const proxyEnabled = body.downloadProxyEnabled ?? settings.downloadProxyEnabled;
    const proxyUrl = typeof body.downloadProxyUrl === "string" ? body.downloadProxyUrl.trim() : settings.downloadProxyUrl.trim();
    const startedAt = Date.now();
    let targetUrl: string;

    try {
      targetUrl = normalizeProxyTestTarget(body.target);
    } catch (error) {
      const rawTarget = body.target?.trim() || "www.google.com";
      return {
        ok: false,
        targetUrl: rawTarget,
        proxyEnabled,
        usedProxy: false,
        status: null,
        statusText: "",
        finalUrl: rawTarget,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    if (proxyEnabled && !proxyUrl) {
      return { ok: false, targetUrl, proxyEnabled, usedProxy: false, status: null, statusText: "", finalUrl: targetUrl, elapsedMs: Date.now() - startedAt, error: "代理地址为空" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(targetUrl, {
        headers: { "user-agent": "MinecraftServerAgent/0.1 ProxyTest" },
        signal: controller.signal,
        dispatcher: proxyEnabled ? fetchDispatcher(proxyUrl) : undefined
      });
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: true,
        targetUrl,
        proxyEnabled,
        usedProxy: proxyEnabled,
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.url,
        elapsedMs: Date.now() - startedAt,
        error: null
      };
    } catch (error) {
      return {
        ok: false,
        targetUrl,
        proxyEnabled,
        usedProxy: proxyEnabled,
        status: null,
        statusText: "",
        finalUrl: targetUrl,
        elapsedMs: Date.now() - startedAt,
        error: controller.signal.aborted ? "连接超时" : error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  const providerKeySettingsSchema = z.object({
    curseForgeApiKey: z.string().optional(),
    modrinthApiKey: z.string().optional()
  });

  app.get("/api/settings/provider-keys", async () => services.promptService.getAgentToolSettings());

  app.put("/api/settings/provider-keys", async (request) => {
    const body = parseBody(providerKeySettingsSchema, request.body);
    return services.promptService.setAgentToolSettings(body);
  });

  app.get("/api/skills", async () => services.skillService.list());

  app.get("/api/tools", async () => listAgentToolInfos(services.promptService.getAgentToolSettings()));

  app.patch("/api/skills/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = parseBody(z.object({ enabled: z.boolean() }), request.body);
    return services.skillService.setEnabled(id, body.enabled);
  });

  app.get("/api/java", async () => services.javaService.getManagementState());

  app.get("/api/java/tasks", async () => services.javaService.listTasks());

  app.get("/api/java/sources", async () => services.javaService.listDownloadSources());

  app.post("/api/java/install", async (request) => {
    const body = parseBody(z.object({ version: z.string().min(1), source: z.string().optional() }), request.body);
    return services.javaService.startInstall(body.version, { source: body.source });
  });

  app.post("/api/java/install/cancel", async (request) => {
    const body = parseBody(z.object({ version: z.string().min(1) }), request.body);
    return services.javaService.cancelInstall(body.version);
  });
}
