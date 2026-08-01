import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfig } from "../../src/config.js";
import { MapService } from "../../src/services/mapService.js";
import type { ProcessManager } from "../../src/services/processManager.js";
import type { ServerService } from "../../src/services/serverService.js";
import type { ServerRecord, ServerStatus } from "../../src/types.js";

const created: string[] = [];

/** Reroutes snapshot storage into a temp directory for the lifetime of the test process. */
export async function useTempSnapshotRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "map-snapshots-"));
  created.push(root);
  appConfig.mapSnapshotsDir = root;
  return root;
}

export async function cleanupTempRoots() {
  for (const root of created) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  created.length = 0;
}

export interface Harness {
  service: MapService;
  serverId: string;
  base: string;
  regionDir: string;
  setStatus(status: ServerStatus): void;
  setActive(serverId: string | null): void;
  setHasProcesses(value: boolean): void;
  exclusiveCalls(): number;
}

export interface HarnessOptions {
  status?: ServerStatus;
  /** Extra sibling directories to create alongside `region`, e.g. `["poi"]`. */
  siblings?: string[];
  worldName?: string;
}

/**
 * Builds a MapService wired to stub ServerService/ProcessManager instances plus a real
 * on-disk world directory, so the file-level behaviour under test is genuine while the
 * database and process supervisor are not involved.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const serverId = "server-test";
  const base = await mkdtemp(path.join(tmpdir(), "map-server-"));
  created.push(base);
  const world = options.worldName ?? "world";
  const regionDir = path.join(base, world, "region");
  await mkdir(regionDir, { recursive: true });
  for (const sibling of options.siblings ?? []) await mkdir(path.join(base, world, sibling), { recursive: true });

  let status: ServerStatus = options.status ?? "stopped";
  let activeServerId: string | null = null;
  let hasProcesses = false;
  let exclusiveCalls = 0;

  const record = (): ServerRecord => ({
    id: serverId,
    name: "test",
    directory: base,
    status,
    javaPath: null,
    javaVersion: null,
    minMemory: "1G",
    maxMemory: "2G",
    jarFile: "server.jar",
    startArgs: "",
    startupCommand: null,
    serverType: null,
    minecraftVersion: null,
    modpackName: null,
    promptOverride: null,
    useGlobalPrompt: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const serverService = {
    async requireServer(id: string) {
      if (id !== serverId) throw new Error("Server not found");
      return record();
    }
  } as unknown as ServerService;

  const processManager = {
    getActiveServerId: () => activeServerId,
    async hasActiveServerProcesses() {
      return hasProcesses;
    },
    async runExclusive<T>(action: () => Promise<T>) {
      exclusiveCalls += 1;
      return action();
    }
  } as unknown as ProcessManager;

  return {
    service: new MapService(serverService, processManager),
    serverId,
    base,
    regionDir,
    setStatus(next) { status = next; },
    setActive(next) { activeServerId = next; },
    setHasProcesses(next) { hasProcesses = next; },
    exclusiveCalls: () => exclusiveCalls
  };
}

export async function writeMapFile(directory: string, name: string, content: Buffer | string) {
  await writeFile(path.join(directory, name), content);
}
