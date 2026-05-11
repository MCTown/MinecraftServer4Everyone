import { EventEmitter } from "node:events";
import type { AgentEvent, ConsoleLogEntry, ServerRecord } from "../types.js";

export interface AppEvents {
  console: [ConsoleLogEntry];
  consoleClear: [{ serverId: string }];
  serverStatus: [{ serverId: string; status: ServerRecord["status"] }];
  agent: [{ serverId: string; event: AgentEvent }];
}

class TypedEventBus extends EventEmitter {
  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]) {
    return super.emit(event, ...args);
  }

  on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void) {
    return super.on(event, listener);
  }

  off<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void) {
    return super.off(event, listener);
  }
}

export const eventBus = new TypedEventBus();
