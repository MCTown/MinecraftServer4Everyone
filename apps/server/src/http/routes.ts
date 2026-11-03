import type { FastifyInstance } from "fastify";
import type { RouteServices } from "./types.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerFileManagerRoutes } from "./routes/fileManager.js";
import { registerGlobalAgentRoutes } from "./routes/globalAgent.js";
import { registerMapRoutes } from "./routes/maps.js";
import { registerServerRoutes } from "./routes/servers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWebSocketRoutes } from "./routes/websockets.js";

export function registerRoutes(app: FastifyInstance, services: RouteServices) {
  registerAuthRoutes(app);
  registerServerRoutes(app, services);
  registerFileRoutes(app, services);
  registerFileManagerRoutes(app, services);
  registerMapRoutes(app, services);
  registerAgentRoutes(app, services);
  registerGlobalAgentRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerWebSocketRoutes(app, services);
}
