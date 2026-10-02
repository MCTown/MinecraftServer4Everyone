import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { createAgentTools } from "../src/agent/tools.js";
import { resolveForgeFamilyInstaller } from "../src/agent/tools/forgeFamilyInstaller.js";
import { createDeployMrpackServerTool } from "../src/agent/tools/mrpackDeploymentTool.js";
import type { AgentCapabilityId, AgentToolContext } from "../src/agent/toolKit.js";
import { FileService } from "../src/services/fileService.js";
import type { ServerSlotStatus } from "../src/types.js";

const argsFile = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
const modernArgs = `libraries/net/neoforged/neoforge/21.4.111-beta/${argsFile}`;
const legacyArgs = `libraries/net/neoforged/forge/1.20.1-47.1.106/${argsFile}`;

function slot(root: string, fileName: string): ServerSlotStatus {
  return { occupied: true, directory: root, filePath: path.join(root, fileName), fileName, size: 0, modifiedAt: null, source: null };
}

async function harness(t: TestContext, mcdr = true) {
  const root = await mkdtemp(path.join(tmpdir(), "neoforge-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = mcdr ? path.join(root, "server") : root;
  await mkdir(installRoot, { recursive: true });
  if (mcdr) await writeFile(path.join(root, "config.yml"), "working_directory: server\n");
  const installerPath = mcdr ? "server/installer.jar" : "installer.jar";
  await writeFile(path.join(root, installerPath), "installer fixture");
  const updates: Record<string, unknown>[] = [];
  const downloads: { url: string; destination: string }[] = [];
  const capabilities = new Set<AgentCapabilityId>();
  const ctx = {
    getServerId: () => "test-server",
    installedCapabilities: capabilities,
    installCapability: (id: AgentCapabilityId) => capabilities.add(id),
    serverService: {
      requireServer: async () => ({ directory: root }),
      updateServer: async (_id: string, changes: Record<string, unknown>) => {
        updates.push(changes);
        return changes;
      }
    },
    fileService: {
      resolveDownload: async (_id: string, relative: string) => ({ absolutePath: path.join(root, relative), fileName: path.basename(relative) }),
      downloadIntoServer: async (_id: string, url: string, destination: string) => {
        downloads.push({ url, destination: destination.replaceAll("\\", "/") });
        await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
        await writeFile(path.join(root, destination), "downloaded installer fixture");
        return destination;
      },
      materializeMrpackOverrides: async () => ({ copiedOverrides: [] }),
      materializeCurseForgeManifestOverrides: async () => ({ copiedOverrides: ["config/test.toml"] })
    },
    javaService: { recommendVersion: (version: string) => version === "1.20.1" ? "17" : "21" }
  } as unknown as AgentToolContext;
  return { root, installRoot, installerPath, ctx, capabilities, updates, downloads };
}

/** Simulate Java at the process boundary while exercising actual installation/configuration writes. */
function installerProcess(t: TestContext, expectedArgsPath: string | null, exitCode = 0) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const spawn = t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    const cwd = String(options.cwd);
    calls.push({ command, args, cwd });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    void (async () => {
      await Promise.resolve();
      if (expectedArgsPath && exitCode === 0) {
        await mkdir(path.dirname(path.join(cwd, expectedArgsPath)), { recursive: true });
        await writeFile(path.join(cwd, expectedArgsPath), "fixture launch arguments\n");
      }
      child.stdout.write("installer output\n");
      child.emit("exit", exitCode, null);
    })().catch((error: Error) => child.emit("error", error));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

function tool(ctx: AgentToolContext, name: string) {
  const found = createAgentTools(ctx).find((entry) => entry.definition.function.name === name);
  assert.ok(found, `Expected tool ${name}`);
  return found;
}

test("NeoForge coordinates distinguish modern and Minecraft 1.20.1 installers on both platforms", () => {
  const modern = resolveForgeFamilyInstaller("neoforge", "1.21.4", "21.4.111-beta", "linux");
  assert.equal(modern.installerUrl, "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.4.111-beta/neoforge-21.4.111-beta-installer.jar");
  assert.equal(modern.argsPath, "libraries/net/neoforged/neoforge/21.4.111-beta/unix_args.txt");
  assert.equal(modern.installFlag, "--installServer");
  assert.equal(resolveForgeFamilyInstaller("neoforge", "1.21.1", "21.1.200", "win32").argsPath, "libraries/net/neoforged/neoforge/21.1.200/win_args.txt");
  for (const version of ["47.1.106", "1.20.1-47.1.106"]) {
    const legacy = resolveForgeFamilyInstaller("neoforge", "1.20.1", version, "win32");
    assert.equal(legacy.version, "47.1.106");
    assert.equal(legacy.installerUrl, "https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar");
    assert.equal(legacy.argsPath, "libraries/net/neoforged/forge/1.20.1-47.1.106/win_args.txt");
  }
  const forge = resolveForgeFamilyInstaller("forge", "1.20.1", "47.2.0", "linux");
  assert.equal(forge.installerUrl, "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar");
  assert.equal(forge.argsPath, "libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt");
  assert.equal(forge.installFlag, "-installServer");
});

test("invalid coordinates and misplaced legacy versions are rejected", () => {
  for (const version of ["", "../../outside", "21.1.1/../../outside", "21.1.1\\outside"]) {
    assert.throws(() => resolveForgeFamilyInstaller("neoforge", "1.21.1", version), /无效/);
  }
  assert.throws(() => resolveForgeFamilyInstaller("neoforge", "../1.21.1", "21.1.200"), /无效/);
  assert.throws(() => resolveForgeFamilyInstaller("neoforge", "1.21.1", "47.1.106"), /仅适用于/);
  assert.throws(() => resolveForgeFamilyInstaller("neoforge", "1.20.1", "21.1.200"), /仅适用于/);
});

test("enabling the NeoForge capability exposes only its own installation tool", async (t) => {
  const { ctx, capabilities } = await harness(t);
  assert.ok(!createAgentTools(ctx).some((entry) => entry.definition.function.name === "setup_neoforge_server"));
  const result = await tool(ctx, "install_agent_capability").execute({ capability: "neoforge_server_setup" });
  assert.match(result, /setup_neoforge_server/);
  assert.ok(capabilities.has("neoforge_server_setup"));
  const definition = tool(ctx, "setup_neoforge_server").definition.function;
  assert.deepEqual(definition.parameters.required, ["minecraftVersion", "neoforgeVersion", "installerPath", "javaPath"]);
  assert.ok(!createAgentTools(ctx).some((entry) => entry.definition.function.name === "setup_forge_server"));
});

for (const scenario of [
  { label: "modern NeoForge in MCDR", loader: "neoforge", mcdr: true, minecraft: "1.21.4", version: "21.4.111-beta", expectedArgs: modernArgs },
  { label: "legacy NeoForge in a plain server", loader: "neoforge", mcdr: false, minecraft: "1.20.1", version: "1.20.1-47.1.106", expectedArgs: legacyArgs },
  { label: "existing Forge in MCDR", loader: "forge", mcdr: true, minecraft: "1.20.1", version: "47.2.0", expectedArgs: `libraries/net/minecraftforge/forge/1.20.1-47.2.0/${argsFile}` }
] as const) {
  test(`standalone installer configures ${scenario.label}`, async (t) => {
    const { ctx, root, installRoot, installerPath, capabilities, updates } = await harness(t, scenario.mcdr);
    capabilities.add(`${scenario.loader}_server_setup`);
    const calls = installerProcess(t, scenario.expectedArgs);
    const confirmations: string[] = [];
    ctx.confirm = async (request) => { confirmations.push(request.title); };
    await writeFile(path.join(installRoot, "server.properties"), "motd=Keep this MOTD\nserver-port=25566\n");
    const versionKey = scenario.loader === "forge" ? "forgeVersion" : "neoforgeVersion";
    const result = JSON.parse(await tool(ctx, `setup_${scenario.loader}_server`).execute({
      minecraftVersion: scenario.minecraft, [versionKey]: scenario.version, installerPath,
      javaPath: process.execPath, minMemory: "6G", maxMemory: "8G"
    }));
    assert.equal(result.ok, true);
    assert.equal(result.installRoot, scenario.mcdr ? "server" : ".");
    assert.equal(result.argsPath, scenario.expectedArgs);
    assert.deepEqual(calls, [{ command: process.execPath, cwd: installRoot, args: ["-jar", path.join(root, installerPath), scenario.loader === "forge" ? "-installServer" : "--installServer"] }]);
    assert.equal(confirmations.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.serverType, scenario.loader);
    assert.equal(updates[0]!.jarFile, "");
    assert.equal(updates[0]!.startArgs, `@${scenario.expectedArgs} nogui`);
    assert.equal(updates[0]!.javaVersion, scenario.minecraft === "1.20.1" ? "17" : "21");
    assert.equal(await readFile(path.join(installRoot, "eula.txt"), "utf8"), "eula=true\n");
    assert.equal(await readFile(path.join(installRoot, "user_jvm_args.txt"), "utf8"), "-Xms6G\n-Xmx6G\n");
    assert.match(await readFile(path.join(installRoot, "server.properties"), "utf8"), /motd=Keep this MOTD\nserver-port=25566\nallow-flight=true/);
    if (scenario.mcdr) {
      assert.deepEqual((await readdir(root)).sort(), ["config.yml", "server"]);
      assert.equal(await readFile(path.join(root, "config.yml"), "utf8"), "working_directory: server\n");
    }
  });
}

test("NeoForge promotes nested pack files into server/", async (t) => {
  const { ctx, root, installRoot, capabilities } = await harness(t);
  capabilities.add("neoforge_server_setup");
  installerProcess(t, modernArgs);
  await mkdir(path.join(installRoot, "pack", "mods"), { recursive: true });
  await writeFile(path.join(installRoot, "pack", "mods", "example.jar"), "mod fixture");
  await writeFile(path.join(installRoot, "pack", "manifest.json"), "{}");
  await writeFile(path.join(installRoot, "pack", "installer.jar"), "installer fixture");
  const result = JSON.parse(await tool(ctx, "setup_neoforge_server").execute({ minecraftVersion: "1.21.4", neoforgeVersion: "21.4.111-beta", installerPath: "server/pack/installer.jar", javaPath: process.execPath }));
  assert.ok(result.promotedContent.moved.includes("mods"));
  assert.equal(await readFile(path.join(installRoot, "mods", "example.jar"), "utf8"), "mod fixture");
  assert.deepEqual((await readdir(root)).sort(), ["config.yml", "server"]);
});

for (const scenario of [{ exitCode: 0, message: /did not create expected args file/ }, { exitCode: 1, message: /进程退出失败/ }]) {
  test(`installation failure does not write successful config (exit ${scenario.exitCode})`, async (t) => {
    const { ctx, installerPath, capabilities, updates } = await harness(t);
    capabilities.add("neoforge_server_setup");
    installerProcess(t, null, scenario.exitCode);
    await assert.rejects(tool(ctx, "setup_neoforge_server").execute({ minecraftVersion: "1.21.4", neoforgeVersion: "21.4.111-beta", installerPath, javaPath: process.execPath }), scenario.message);
    assert.deepEqual(updates, []);
  });
}

for (const scenario of [
  { loader: "neoforge-21.4.111-beta", minecraft: "1.21.4", type: "neoforge", file: "neoforge/21.4.111-beta/neoforge-21.4.111-beta-installer.jar" },
  { loader: "NeoForge-47.1.106", minecraft: "1.20.1", type: "neoforge", file: "forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar" },
  { loader: "neo-forge-1.20.1-47.1.106", minecraft: "1.20.1", type: "neoforge", file: "forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar" },
  { loader: "forge-47.2.0", minecraft: "1.20.1", type: "forge", file: "forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar" },
  { loader: "fabric-0.16.0", minecraft: "1.21.1", type: "fabric", file: "" }
]) {
  test(`CurseForge manifest returns the correct setup instructions for ${scenario.loader}`, async (t) => {
    const { ctx, root } = await harness(t);
    ctx.fileService.inspectCurseForgeManifestServerSlot = async () => ({
      name: "Fixture pack", version: "1.0", minecraftVersion: scenario.minecraft,
      loaders: [scenario.loader, "forge-47.0.0"], files: [{ projectId: "1", fileId: "2", required: false }],
      overridesPath: "overrides", slot: slot(root, "pack.zip")
    });
    const result = JSON.parse(await tool(ctx, "materialize_curseforge_manifest_pack_from_server_slot").execute({}));
    assert.deepEqual(result.copiedOverrides, ["config/test.toml"]);
    if (scenario.type === "fabric") {
      assert.equal(result.loaderSetup.status, "manual_loader_setup_required");
    } else {
      assert.equal(result.loaderSetup.status, "pending");
      assert.equal(result.loaderSetup.loader, scenario.type);
      const repository = scenario.type === "forge" ? "https://maven.minecraftforge.net/net/minecraftforge/" : "https://maven.neoforged.net/releases/net/neoforged/";
      assert.equal(result.loaderSetup.officialInstallerUrl, repository + scenario.file);
      assert.match(result.loaderSetup.nextSteps.join("\n"), new RegExp(`setup_${scenario.type}_server`));
      assert.ok(result.loaderSetup[scenario.type === "forge" ? "forgeVersion" : "neoforgeVersion"]);
    }
  });
}

test("CurseForge manifest parsing puts the explicitly primary NeoForge loader first", async (t) => {
  const { ctx, root } = await harness(t);
  const service = new FileService(ctx.serverService);
  service.getServerSlotStatus = async () => slot(root, "pack.zip");
  // Stub archive extraction only; the on-disk manifest still goes through the real parser.
  t.mock.method(service as unknown as { extractZipArchive: (file: string, destination: string) => Promise<void> }, "extractZipArchive", async (_file: string, destination: string) => {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "manifest.json"), JSON.stringify({
      manifestType: "minecraftModpack", name: "Primary NeoForge", version: "1.0",
      minecraft: { version: "1.21.4", modLoaders: [{ id: "forge-54.0.0", primary: false }, { id: "neoforge-21.4.111-beta", primary: true }] },
      files: [{ projectID: 1, fileID: 2, required: true }], overrides: "overrides"
    }));
  });
  const manifest = await service.inspectCurseForgeManifestServerSlot("test-server");
  assert.deepEqual(manifest.loaders, ["neoforge-21.4.111-beta", "forge-54.0.0"]);
});

for (const scenario of [
  { minecraft: "1.21.4", version: "21.4.111-beta", expectedArgs: modernArgs, file: "neoforge-21.4.111-beta-installer.jar", coordinate: "neoforge/21.4.111-beta" },
  { minecraft: "1.20.1", version: "47.1.106", expectedArgs: legacyArgs, file: "forge-1.20.1-47.1.106-installer.jar", coordinate: "forge/1.20.1-47.1.106" }
]) {
  test(`mrpack deployment installs NeoForge ${scenario.version} with matching download and launch paths`, async (t) => {
    const { ctx, root, installRoot, downloads, updates } = await harness(t);
    ctx.fileService.inspectMrpackServerSlot = async () => ({
      name: "NeoForge mrpack", versionId: "1.0", formatVersion: 1, minecraftVersion: scenario.minecraft,
      dependencies: { minecraft: scenario.minecraft, neoforge: scenario.version }, files: [],
      overrideDirectories: [], slot: slot(root, "pack.mrpack")
    });
    const calls = installerProcess(t, scenario.expectedArgs);
    const result = JSON.parse(await createDeployMrpackServerTool(ctx).execute({ javaPath: process.execPath }));
    assert.equal(result.ok, true);
    assert.equal(result.loader.type, "neoforge");
    assert.deepEqual(downloads, [{ url: `https://maven.neoforged.net/releases/net/neoforged/${scenario.coordinate}/${scenario.file}`, destination: `server/${scenario.file}` }]);
    assert.equal(calls[0]!.cwd, installRoot);
    assert.equal(calls[0]!.args.at(-1), "--installServer");
    assert.equal(updates[0]!.startArgs, `@${scenario.expectedArgs} nogui`);
    assert.equal(updates[0]!.serverType, "neoforge");
  });
}
