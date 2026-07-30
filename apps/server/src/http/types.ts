import type { AgentService } from "../agent/agentService.js";
import type { ConsoleLogService } from "../services/consoleLogService.js";
import type { FileService } from "../services/fileService.js";
import type { JavaService } from "../services/javaService.js";
import type { ModelService } from "../services/modelService.js";
import type { MapService } from "../services/mapService.js";
import type { ProcessManager } from "../services/processManager.js";
import type { PromptService } from "../services/promptService.js";
import type { ServerErrorService } from "../services/serverErrorService.js";
import type { ServerService } from "../services/serverService.js";
import type { SkillService } from "../services/skillService.js";
import type { UploadService } from "../services/uploadService.js";

export interface RouteServices {
  serverService: ServerService;
  serverErrorService: ServerErrorService;
  consoleLogService: ConsoleLogService;
  fileService: FileService;
  mapService: MapService;
  processManager: ProcessManager;
  modelService: ModelService;
  promptService: PromptService;
  skillService: SkillService;
  uploadService: UploadService;
  javaService: JavaService;
  agentService: AgentService;
}
