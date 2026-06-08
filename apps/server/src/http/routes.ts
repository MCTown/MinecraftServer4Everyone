import type { FastifyInstance } from "fastify";
import type { RouteServices } from "./types.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerServerRoutes } from "./routes/servers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWebSocketRoutes } from "./routes/websockets.js";

export function registerRoutes(app: FastifyInstance, services: RouteServices) {
  registerAuthRoutes(app);
  registerServerRoutes(app, services);
  registerFileRoutes(app, services);
  registerAgentRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerWebSocketRoutes(app, services);
}
