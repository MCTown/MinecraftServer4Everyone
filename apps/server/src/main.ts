import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { appConfig } from "./config.js";
import { initDatabase } from "./db/client.js";
import { registerErrorHandling } from "./http/errors.js";
import { registerRoutes } from "./http/routes.js";
import { ensureRuntimeDirectories } from "./runtime.js";
import { AgentService } from "./agent/agentService.js";
import { ConsoleLogService } from "./services/consoleLogService.js";
import { FileService } from "./services/fileService.js";
import { JavaService } from "./services/javaService.js";
import { ModelService } from "./services/modelService.js";
import { ProcessManager } from "./services/processManager.js";
import { PromptService } from "./services/promptService.js";
import { ServerErrorService } from "./services/serverErrorService.js";
import { ServerService } from "./services/serverService.js";
import { SkillService } from "./services/skillService.js";
import { UploadService } from "./services/uploadService.js";

async function bootstrap() {
  await ensureRuntimeDirectories();
  initDatabase();

  const serverService = new ServerService();
  const consoleLogService = new ConsoleLogService();
  const serverErrorService = new ServerErrorService(serverService, consoleLogService);
  const fileService = new FileService(serverService);
  const modelService = new ModelService();
  const skillService = new SkillService();
  const promptService = new PromptService(serverService, skillService);
  const javaService = new JavaService(() => promptService.getAgentDownloadProxyUrl());
  const processManager = new ProcessManager(serverService, consoleLogService, promptService, javaService);
  const uploadService = new UploadService();
  const agentService = new AgentService(
    serverService,
    consoleLogService,
    fileService,
    processManager,
    modelService,
    promptService,
    uploadService,
    javaService
  );

  await processManager.resetStatuses();
  await skillService.ensureBuiltInSkills();
  uploadService.cleanupExpired();
  setInterval(() => uploadService.cleanupExpired(), 60 * 60 * 1000).unref();

  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 50 });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
  await app.register(websocket);
  registerErrorHandling(app);
  registerRoutes(app, {
    serverService,
    serverErrorService,
    consoleLogService,
    fileService,
    processManager,
    modelService,
    promptService,
    skillService,
    uploadService,
    javaService,
    agentService
  });

  await app.listen({ host: appConfig.host, port: appConfig.port });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
