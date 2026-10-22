interface Request {
  resources: string[];
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
}

const conflicts = (left: string, right: string) => left === right
  || (left.endsWith(":*") && right.startsWith(left.slice(0, -1)))
  || (right.endsWith(":*") && left.startsWith(right.slice(0, -1)));

/** Process-owned resource leases, not a claim of cross-process fencing. Waiters
 * are event driven and conflicting requests preserve admission order. */
export class ResourceScheduler {
  private active = new Set<string[]>();
  private pending: Request[] = [];

  acquire(resources: string[], signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException("Agent 操作已中断", "AbortError"));
    return new Promise((resolve, reject) => {
      const request: Request = { resources: [...new Set(resources)].sort(), resolve, reject, signal,
        abort: () => {
          this.pending = this.pending.filter((entry) => entry !== request);
          reject(new DOMException("Agent 操作已中断", "AbortError"));
          this.drain();
        } };
      this.pending.push(request);
      signal.addEventListener("abort", request.abort, { once: true });
      this.drain();
    });
  }

  private drain() {
    const blocked: string[][] = [];
    for (const request of [...this.pending]) {
      const collides = (held: string[]) => request.resources.some((a) => held.some((b) => conflicts(a, b)));
      if ([...this.active, ...blocked].some(collides)) { blocked.push(request.resources); continue; }
      this.pending = this.pending.filter((entry) => entry !== request);
      request.signal.removeEventListener("abort", request.abort);
      this.active.add(request.resources);
      let released = false;
      request.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(request.resources);
        this.drain();
      });
    }
  }

  async run<T>(resources: string[], signal: AbortSignal, execute: () => Promise<T>) {
    const release = await this.acquire(resources, signal);
    try {
      if (signal.aborted) throw new DOMException("Agent 操作已中断", "AbortError");
      return await execute();
    } finally { release(); }
  }
}

export const agentResources = new ResourceScheduler();

export function toolResources(scopeId: string, name: string, args: Record<string, unknown>): string[] {
  if (["start_instance", "stop_instance"].includes(name) && typeof args.serverId === "string") return [`server:${args.serverId}:*`];
  if (name === "install_java_version") return [`workspace:jdk:${String(args.version)}`];
  if (["setup_forge_server", "setup_neoforge_server", "deploy_mrpack_server_from_server_slot"].includes(name)) return [`server:${scopeId}:loader`];
  if (name === "run_shell_command") {
    // Closed workflow branches explicitly declare separate ownership. Arbitrary
    // shell commands remain exclusive; a model cannot invent arbitrary lock names.
    if (args.workflowStepId === "configure_mcdr") return [`server:${scopeId}:mcdr`];
    if (args.workflowStepId === "install_modloader") return [`server:${scopeId}:loader`];
    return [`server:${scopeId}:*`];
  }
  if (["update_current_server_config", "start_current_server", "stop_current_server", "kill_current_server", "send_current_server_command", "write_server_text_file",
    "initialize_server_template", "extract_server_zip", "extract_server_slot_to_workspace", "move_upload_to_server"].includes(name)) return [`server:${scopeId}:*`];
  return [];
}
