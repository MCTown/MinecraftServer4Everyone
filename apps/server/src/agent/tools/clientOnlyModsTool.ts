import { createRequire } from "node:module";
import { readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { booleanInput, objectSchema, requireConfirmation, stringArrayInput, stringInput, stringProperty, type AgentTool, type AgentToolContext, type AgentToolInfo } from "../toolKit.js";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl") as {
  open: (file: string, options: { lazyEntries: boolean; autoClose?: boolean }, callback: (error: Error | null, zipfile?: YauzlZipFile) => void) => void;
};

interface YauzlEntry {
  fileName: string;
}

interface YauzlZipFile {
  readEntry: () => void;
  openReadStream: (entry: YauzlEntry, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) => void;
  on: (event: "entry" | "end" | "error", listener: (...args: any[]) => void) => void;
  close?: () => void;
}

export const inspectClientOnlyServerModsToolInfo: AgentToolInfo = {
  name: "inspect_client_only_server_mods",
  description: "扫描当前服务端 server/mods（或指定目录）中的 .jar，识别仅客户端模组。综合 Fabric/Quilt environment、Forge/NeoForge mods.toml 依赖 side，以及常见客户端文件名启发式；只报告，不修改文件。",
  category: "模组检查",
  controllable: false
};

export const disableClientOnlyServerModsToolInfo: AgentToolInfo = {
  name: "disable_client_only_server_mods",
  description: "扫描当前服务端 mods 目录中的仅客户端模组，并将它们重命名为 .jar.disabled 以禁用（不删除）。默认只禁用高置信度结果；可用于直启前清理导致崩溃的客户端模组。",
  category: "模组检查",
  controllable: false
};

export const disableServerModsToolInfo: AgentToolInfo = {
  name: "disable_server_mods",
  description: "按用户指定、崩溃日志点名或 Agent 判断，禁用 server/mods 中的指定模组（重命名为 .jar.disabled，不删除）。targets 可写文件名、相对路径、modId 或关键词；用于自动扫描未覆盖但仍导致无法启动的模组，或用户明确要求禁用的模组。",
  category: "模组检查",
  controllable: false
};

type DetectionConfidence = "high" | "medium" | "low";
type DetectionSide = "client" | "server" | "both" | "unknown";

interface ModScanResult {
  fileName: string;
  relativePath: string;
  absolutePath: string;
  disabled: boolean;
  loader: string[];
  modIds: string[];
  displayName: string;
  side: DetectionSide;
  confidence: DetectionConfidence;
  reasons: string[];
  clientOnly: boolean;
}

const knownClientOnlyPatterns = [
  /^iris([\-_].*)?$/i,
  /^oculus([\-_].*)?$/i,
  /^sodium([\-_].*)?$/i,
  /^embeddium([\-_].*)?$/i,
  /^rubidium([\-_].*)?$/i,
  /^xenon([\-_].*)?$/i,
  /^optifine([\-_].*)?$/i,
  /^optifabric([\-_].*)?$/i,
  /^modmenu([\-_].*)?$/i,
  /^catalogue([\-_].*)?$/i,
  /^controlling([\-_].*)?$/i,
  /^notenoughanimations([\-_].*)?$/i,
  /^entityculling([\-_].*)?$/i,
  /^dynamic[\-_]?fps([\-_].*)?$/i,
  /^betterf3([\-_].*)?$/i,
  /^lambdynamiclights([\-_].*)?$/i,
  /^dynamiclights([\-_].*)?$/i,
  /^presencefootsteps([\-_].*)?$/i,
  /^soundphysics([\-_].*)?$/i,
  /^firstperson([\-_].*)?$/i,
  /^freecam([\-_].*)?$/i,
  /^okzoomer([\-_].*)?$/i,
  /^zoomify([\-_].*)?$/i,
  /^citresewn([\-_].*)?$/i,
  /^entity[\-_]?model[\-_]?features([\-_].*)?$/i,
  /^entity[\-_]?texture[\-_]?features([\-_].*)?$/i,
  /^skin[\-_]?layers([\-_].*)?$/i,
  /^3dskinlayers([\-_].*)?$/i,
  /^appleskin([\-_].*)?$/i,
  /^chat[\-_]?heads([\-_].*)?$/i,
  /^fancymenu([\-_].*)?$/i,
  /^fancy[\-_]?menu([\-_].*)?$/i,
  /^mouse[\-_]?tweaks([\-_].*)?$/i,
  /^mousetweaks([\-_].*)?$/i,
  /^betterpingdisplay([\-_].*)?$/i,
  /^waveycapes([\-_].*)?$/i,
  /^continuity([\-_].*)?$/i,
  /^freshanimations([\-_].*)?$/i,
  /^eatingsanimation([\-_].*)?$/i,
  /^itemphysic(s|lite)?([\-_].*)?$/i,
  /^blur([\-_].*)?$/i,
  /^adaptiveui([\-_].*)?$/i,
  /^rrls([\-_].*)?$/i,
  /^immediatelyfast([\-_].*)?$/i,
  /^reeses[\-_]?sodium[\-_]?options([\-_].*)?$/i,
  /^sodium[\-_]?extra([\-_].*)?$/i,
  /^irissearch([\-_].*)?$/i,
  /^distanthorizons([\-_].*)?$/i,
  /^bobby([\-_].*)?$/i,
  /^yacl([\-_].*)?$/i,
  /^yet[\-_]?another[\-_]?config[\-_]?lib([\-_].*)?$/i,
  /^modelfix([\-_].*)?$/i,
  /^entity[\-_]?effect[\-_]?renderer([\-_].*)?$/i,
  /^puzzle([\-_].*)?$/i,
  /^capes([\-_].*)?$/i,
  /^ears([\-_].*)?$/i
];

const knownClientOnlyFileNameHints = [
  "iris", "oculus", "sodium", "embeddium", "rubidium", "xenon", "optifine", "optifabric",
  "modmenu", "catalogue", "controlling", "notenoughanimations", "entityculling", "dynamicfps", "dynamic-fps",
  "betterf3", "lambdynamiclights", "dynamiclights", "presencefootsteps", "soundphysics", "firstperson",
  "freecam", "okzoomer", "zoomify", "citresewn", "entity_model_features", "entity_texture_features",
  "skinlayers", "3dskinlayers", "appleskin", "chat_heads", "chatheads", "fancymenu", "mousetweaks",
  "mouse-tweaks", "betterpingdisplay", "waveycapes", "continuity", "freshanimations", "itemphysic",
  "immediatelyfast", "sodium-extra", "reeses-sodium", "irissearch", "bobby", "yacl", "yetanotherconfiglib",
  "modelfix", "capes", "rrls", "blur"
];

function isDisabledModName(fileName: string) {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".disabled") || lower.endsWith(".clientdisabled") || lower.endsWith(".jar.disabled");
}

function isActiveJarName(fileName: string) {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".jar") && !isDisabledModName(fileName);
}

function normalizeId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesKnownClientId(idOrName: string) {
  const raw = idOrName.trim();
  if (!raw) return false;
  const compact = normalizeId(raw);
  if (knownClientOnlyPatterns.some((pattern) => pattern.test(raw) || pattern.test(compact))) return true;
  return knownClientOnlyFileNameHints.some((hint) => {
    const compactHint = normalizeId(hint);
    return compact === compactHint || compact.startsWith(compactHint) || raw.toLowerCase().includes(hint);
  });
}

function readZipEntries(filePath: string, wanted: string[]) {
  const wantedSet = new Set(wanted.map((item) => item.replaceAll("\\", "/").toLowerCase()));
  return new Promise<Map<string, string>>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error(`无法打开模组 jar：${filePath}`));
        return;
      }
      const found = new Map<string, string>();
      let settled = false;
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(found);
      };
      zipfile.on("error", fail);
      zipfile.on("end", finish);
      zipfile.on("entry", (entry: YauzlEntry) => {
        const name = entry.fileName.replaceAll("\\", "/");
        const lower = name.toLowerCase();
        if (!wantedSet.has(lower)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`无法读取 jar 条目：${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on("error", fail);
          stream.on("end", () => {
            found.set(lower, Buffer.concat(chunks).toString("utf8"));
            if (found.size >= wantedSet.size) {
              finish();
              zipfile.close?.();
              return;
            }
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

function stripTomlComments(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const hash = line.indexOf("#");
      if (hash < 0) return line;
      const before = line.slice(0, hash);
      const quotes = (before.match(/"/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join("\n");
}

function parseSimpleTomlTables(text: string) {
  const cleaned = stripTomlComments(text);
  const tables: Array<{ header: string; body: string }> = [];
  const regex = /^\[(\[[^\]]+\]|[^\]]+)\]\s*$/gm;
  const matches = [...cleaned.matchAll(regex)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const header = match[1]!.trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? cleaned.length) : cleaned.length;
    tables.push({ header, body: cleaned.slice(start, end) });
  }
  return tables;
}

function readTomlString(body: string, key: string) {
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, "i"),
    new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*'([^']*)'`, "i"),
    new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*'''([\\s\\S]*?)'''`, "i"),
    new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"""([\\s\\S]*?)"""`, "i"),
    new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([^\\n#]+)`, "i")
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (!match) continue;
    return match[1]!.trim().replace(/^"+|"+$/g, "").trim();
  }
  return "";
}

function parseForgeSideFromToml(text: string) {
  const tables = parseSimpleTomlTables(text);
  const modIds: string[] = [];
  const displayNames: string[] = [];
  const dependencySides = new Map<string, string[]>();

  for (const table of tables) {
    const header = table.header.replaceAll(" ", "");
    if (header === "[mods]" || header === "mods") {
      const modId = readTomlString(table.body, "modId");
      const displayName = readTomlString(table.body, "displayName");
      if (modId) modIds.push(modId);
      if (displayName) displayNames.push(displayName);
      continue;
    }
    const dependencyMatch = header.match(/^\[dependencies\.([^\]]+)\]$/i) || header.match(/^dependencies\.([^\]]+)$/i);
    if (!dependencyMatch) continue;
    const owner = dependencyMatch[1]!.trim().toLowerCase();
    const side = readTomlString(table.body, "side").toUpperCase() || "BOTH";
    const type = (readTomlString(table.body, "type") || readTomlString(table.body, "mandatory") || "").toLowerCase();
    const mandatory = type === "true" || type === "required" || type === "";
    if (!mandatory && type === "optional") continue;
    const list = dependencySides.get(owner) ?? [];
    list.push(side);
    dependencySides.set(owner, list);
  }

  let clientOnlyByDeps = false;
  for (const modId of modIds) {
    const sides = dependencySides.get(modId.toLowerCase()) ?? [];
    if (sides.length === 0) continue;
    if (sides.every((side) => side === "CLIENT")) {
      clientOnlyByDeps = true;
      break;
    }
  }

  return { modIds, displayNames, clientOnlyByDeps };
}

function analyzeFabricJson(text: string) {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    const name = typeof data.name === "string" ? data.name : "";
    const environment = typeof data.environment === "string" ? data.environment.toLowerCase() : "*";
    return { id, name, environment };
  } catch {
    return { id: "", name: "", environment: "*" };
  }
}

async function analyzeModJar(absolutePath: string, relativePath: string): Promise<ModScanResult> {
  const fileName = path.basename(absolutePath);
  const disabled = isDisabledModName(fileName);
  const reasons: string[] = [];
  const loader: string[] = [];
  const modIds: string[] = [];
  let displayName = "";
  let side: DetectionSide = "unknown";
  let confidence: DetectionConfidence = "low";
  let clientOnly = false;

  try {
    const entries = await readZipEntries(absolutePath, [
      "fabric.mod.json",
      "quilt.mod.json",
      "META-INF/mods.toml",
      "META-INF/neoforge.mods.toml"
    ]);

    const fabricText = entries.get("fabric.mod.json");
    if (fabricText) {
      loader.push("fabric");
      const fabric = analyzeFabricJson(fabricText);
      if (fabric.id) modIds.push(fabric.id);
      if (fabric.name) displayName = fabric.name;
      if (fabric.environment === "client") {
        clientOnly = true;
        side = "client";
        confidence = "high";
        reasons.push("fabric.mod.json environment=client");
      } else if (fabric.environment === "server") {
        side = "server";
        confidence = "high";
        reasons.push("fabric.mod.json environment=server");
      } else {
        side = "both";
        reasons.push(`fabric.mod.json environment=${fabric.environment || "*"}`);
      }
    }

    const quiltText = entries.get("quilt.mod.json");
    if (quiltText) {
      loader.push("quilt");
      const quilt = analyzeFabricJson(quiltText);
      if (quilt.id) modIds.push(quilt.id);
      if (quilt.name && !displayName) displayName = quilt.name;
      if (quilt.environment === "client") {
        clientOnly = true;
        side = "client";
        confidence = "high";
        reasons.push("quilt.mod.json environment=client");
      }
    }

    for (const key of ["meta-inf/neoforge.mods.toml", "meta-inf/mods.toml"] as const) {
      const text = entries.get(key);
      if (!text) continue;
      loader.push(key.includes("neoforge") ? "neoforge" : "forge");
      const parsed = parseForgeSideFromToml(text);
      modIds.push(...parsed.modIds);
      if (!displayName && parsed.displayNames[0]) displayName = parsed.displayNames[0]!;
      if (parsed.clientOnlyByDeps) {
        clientOnly = true;
        side = "client";
        confidence = confidence === "high" ? "high" : "medium";
        reasons.push(`${key} 全部 required 依赖 side=CLIENT`);
      }
    }

    const idHit = modIds.find((id) => matchesKnownClientId(id));
    const nameHit = matchesKnownClientId(fileName) || (displayName ? matchesKnownClientId(displayName) : false);
    if (idHit || nameHit) {
      clientOnly = true;
      side = "client";
      if (confidence === "low") confidence = "medium";
      reasons.push(idHit ? `已知客户端模组 ID：${idHit}` : `文件名/显示名匹配常见客户端模组：${fileName}`);
    }

    if (!clientOnly && side === "unknown") {
      reasons.push("未从元数据判定为仅客户端");
    }
  } catch (error) {
    reasons.push(`读取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    fileName,
    relativePath,
    absolutePath,
    disabled,
    loader: [...new Set(loader)],
    modIds: [...new Set(modIds)],
    displayName,
    side,
    confidence,
    reasons,
    clientOnly
  };
}

async function resolveModsDirectory(ctx: AgentToolContext, modsPathInput: string) {
  const server = await ctx.serverService.requireServer(ctx.serverId);
  const requested = (modsPathInput.trim() || "server/mods").replaceAll("\\", "/");
  const absolute = path.resolve(server.directory, requested);
  const relative = path.relative(server.directory, absolute).replaceAll("\\", "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("mods 路径必须位于当前服务端沙箱内");
  }
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`mods 目录不存在：${relative || requested}`);
  return { server, absolute, relative: relative || "." };
}

async function listModFiles(modsDirectory: string, includeDisabled: boolean) {
  const entries = await readdir(modsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => includeDisabled ? (isActiveJarName(name) || isDisabledModName(name) && name.toLowerCase().includes(".jar")) : isActiveJarName(name))
    .sort((first, second) => first.localeCompare(second));
}

async function scanMods(ctx: AgentToolContext, modsPath: string, includeDisabled: boolean) {
  const { absolute, relative } = await resolveModsDirectory(ctx, modsPath);
  const files = await listModFiles(absolute, includeDisabled);
  const results: ModScanResult[] = [];
  for (const fileName of files) {
    const absolutePath = path.join(absolute, fileName);
    const relativePath = path.join(relative, fileName).replaceAll("\\", "/");
    results.push(await analyzeModJar(absolutePath, relativePath));
  }
  const clientOnly = results.filter((item) => item.clientOnly && !item.disabled);
  const alreadyDisabled = results.filter((item) => item.clientOnly && item.disabled);
  return {
    modsPath: relative,
    scannedCount: results.length,
    clientOnlyCount: clientOnly.length,
    alreadyDisabledCount: alreadyDisabled.length,
    clientOnly,
    alreadyDisabled,
    results
  };
}

function summaryPayload(scan: Awaited<ReturnType<typeof scanMods>>, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    modsPath: scan.modsPath,
    scannedCount: scan.scannedCount,
    clientOnlyCount: scan.clientOnlyCount,
    alreadyDisabledCount: scan.alreadyDisabledCount,
    clientOnly: scan.clientOnly.map((item) => ({
      fileName: item.fileName,
      relativePath: item.relativePath,
      modIds: item.modIds,
      displayName: item.displayName,
      loader: item.loader,
      confidence: item.confidence,
      reasons: item.reasons
    })),
    alreadyDisabled: scan.alreadyDisabled.map((item) => ({
      fileName: item.fileName,
      relativePath: item.relativePath,
      modIds: item.modIds,
      reasons: item.reasons
    })),
    ...extra
  };
}

export function createInspectClientOnlyServerModsTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: inspectClientOnlyServerModsToolInfo.name,
        description: inspectClientOnlyServerModsToolInfo.description,
        parameters: objectSchema({
          modsPath: stringProperty,
          includeDisabled: { type: "boolean" }
        })
      }
    },
    execute: async (input) => {
      const modsPath = stringInput(input, "modsPath", "server/mods");
      const includeDisabled = booleanInput(input, "includeDisabled", true);
      const scan = await scanMods(ctx, modsPath, includeDisabled);
      return JSON.stringify(summaryPayload(scan, {
        nextSteps: scan.clientOnlyCount > 0
          ? ["如需禁用仅客户端模组，调用 disable_client_only_server_mods（可设 minConfidence=high|medium）", "若日志点名或用户指定具体模组，调用 disable_server_mods 并传入 targets", "禁用后重新 start_current_server 验证"]
          : ["未发现活跃的仅客户端模组；若启动仍因某个模组失败，用 disable_server_mods 按文件名/modId/关键词禁用"]
      }), null, 2);
    }
  };
}

function collectDisableTargets(input: Record<string, unknown>) {
  const targets = [
    ...stringArrayInput(input, "targets"),
    ...stringArrayInput(input, "mods"),
    ...stringArrayInput(input, "modNames")
  ];
  const singleKeys = ["target", "mod", "modName", "fileName", "modId"] as const;
  for (const key of singleKeys) {
    const value = stringInput(input, key).trim();
    if (value) targets.push(value);
  }
  return [...new Set(targets.map((item) => item.trim()).filter(Boolean))];
}

function normalizeMatchText(value: string) {
  return value.trim().toLowerCase().replaceAll("\\", "/");
}

function matchScoreForTarget(mod: ModScanResult, rawTarget: string) {
  const target = normalizeMatchText(rawTarget);
  if (!target) return 0;
  const fileName = normalizeMatchText(mod.fileName);
  const relativePath = normalizeMatchText(mod.relativePath);
  const displayName = normalizeMatchText(mod.displayName);
  const basenames = new Set([fileName, fileName.replace(/\.disabled$/i, ""), fileName.replace(/\.jar\.disabled$/i, ""), fileName.replace(/\.jar$/i, "")]);
  const modIds = mod.modIds.map((id) => normalizeMatchText(id));
  const compactTarget = normalizeId(target);
  const compactFile = normalizeId(fileName);

  if (relativePath === target || fileName === target) return 100;
  if ([...basenames].some((name) => name === target || name === `${target}.jar`)) return 95;
  if (modIds.some((id) => id === target)) return 90;
  if (compactTarget && modIds.some((id) => normalizeId(id) === compactTarget)) return 88;
  if (displayName && displayName === target) return 85;
  if (fileName.includes(target) || relativePath.includes(target)) return 70;
  if (modIds.some((id) => id.includes(target))) return 65;
  if (displayName && displayName.includes(target)) return 60;
  if (compactTarget.length >= 3 && (compactFile.includes(compactTarget) || modIds.some((id) => normalizeId(id).includes(compactTarget)))) return 55;
  return 0;
}

async function disableMatchedMods(ctx: AgentToolContext, options: {
  modsPath: string;
  targets: string[];
  dryRun: boolean;
  confirmationTitle: string;
  confirmationDescription: (count: number, names: string[]) => string;
}) {
  const { absolute, relative } = await resolveModsDirectory(ctx, options.modsPath);
  const files = await listModFiles(absolute, true);
  const mods: ModScanResult[] = [];
  for (const fileName of files) {
    const absolutePath = path.join(absolute, fileName);
    const relativePath = path.join(relative, fileName).replaceAll("\\", "/");
    mods.push(await analyzeModJar(absolutePath, relativePath));
  }

  const matched = new Map<string, { mod: ModScanResult; score: number; matchedBy: string[] }>();
  const unmatched: string[] = [];
  for (const target of options.targets) {
    let best: { mod: ModScanResult; score: number } | null = null;
    for (const mod of mods) {
      const score = matchScoreForTarget(mod, target);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { mod, score };
    }
    if (!best) {
      unmatched.push(target);
      continue;
    }
    const key = best.mod.absolutePath;
    const existing = matched.get(key);
    if (existing) {
      existing.matchedBy.push(target);
      existing.score = Math.max(existing.score, best.score);
    } else {
      matched.set(key, { mod: best.mod, score: best.score, matchedBy: [target] });
    }
  }

  const alreadyDisabled: Array<{ fileName: string; relativePath: string; matchedBy: string[] }> = [];
  const toDisable: Array<{ mod: ModScanResult; matchedBy: string[]; score: number }> = [];
  for (const item of matched.values()) {
    if (item.mod.disabled) {
      alreadyDisabled.push({
        fileName: item.mod.fileName,
        relativePath: item.mod.relativePath,
        matchedBy: item.matchedBy
      });
      continue;
    }
    toDisable.push(item);
  }

  if (toDisable.length === 0) {
    return {
      ok: true,
      modsPath: relative,
      dryRun: options.dryRun,
      targets: options.targets,
      disabled: [],
      alreadyDisabled,
      unmatched,
      skipped: [],
      message: unmatched.length > 0
        ? `未找到可禁用的活跃模组；未匹配：${unmatched.join(", ")}`
        : alreadyDisabled.length > 0
          ? "指定模组均已禁用"
          : "没有匹配到需要禁用的模组"
    };
  }

  if (!options.dryRun) {
    await requireConfirmation(ctx, {
      title: options.confirmationTitle,
      description: options.confirmationDescription(
        toDisable.length,
        toDisable.map((item) => item.mod.fileName)
      ),
      risk: "medium"
    });
  }

  const disabled: Array<{ from: string; to: string; matchedBy: string[]; score: number; modIds: string[] }> = [];
  const skipped: Array<{ fileName: string; reason: string }> = [];
  for (const item of toDisable) {
    const destinationPath = `${item.mod.absolutePath}.disabled`;
    const toRelative = `${item.mod.relativePath}.disabled`;
    if (options.dryRun) {
      disabled.push({
        from: item.mod.relativePath,
        to: toRelative,
        matchedBy: item.matchedBy,
        score: item.score,
        modIds: item.mod.modIds
      });
      continue;
    }
    try {
      await rename(item.mod.absolutePath, destinationPath);
      disabled.push({
        from: item.mod.relativePath,
        to: toRelative,
        matchedBy: item.matchedBy,
        score: item.score,
        modIds: item.mod.modIds
      });
    } catch (error) {
      skipped.push({
        fileName: item.mod.fileName,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ok: skipped.length === 0 && unmatched.length === 0,
    modsPath: relative,
    dryRun: options.dryRun,
    targets: options.targets,
    disabled,
    alreadyDisabled,
    unmatched,
    skipped,
    message: options.dryRun
      ? `预览：将禁用 ${disabled.length} 个指定模组${unmatched.length ? `，未匹配 ${unmatched.length} 个` : ""}`
      : `已禁用 ${disabled.length} 个指定模组${skipped.length ? `，跳过 ${skipped.length} 个` : ""}${unmatched.length ? `，未匹配 ${unmatched.length} 个` : ""}`
  };
}

export function createDisableServerModsTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: disableServerModsToolInfo.name,
        description: disableServerModsToolInfo.description,
        parameters: objectSchema({
          targets: { type: "array", items: stringProperty },
          target: stringProperty,
          modsPath: stringProperty,
          dryRun: { type: "boolean" }
        })
      }
    },
    execute: async (input) => {
      const targets = collectDisableTargets(input);
      if (targets.length === 0) {
        throw new Error("必须提供 targets（字符串数组）或 target（单个文件名/modId/关键词），用于指定要禁用的模组");
      }
      const modsPath = stringInput(input, "modsPath", "server/mods");
      const dryRun = booleanInput(input, "dryRun", false);
      const result = await disableMatchedMods(ctx, {
        modsPath,
        targets,
        dryRun,
        confirmationTitle: "禁用指定模组",
        confirmationDescription: (count, names) =>
          `Agent 准备将 ${count} 个指定模组重命名为 .jar.disabled（不删除）：${names.slice(0, 8).join(", ")}${names.length > 8 ? " 等" : ""}。`
      });
      return JSON.stringify({
        ...result,
        nextSteps: [
          "若仍启动失败，根据最新日志继续 disable_server_mods",
          "批量清理已知仅客户端模组可用 disable_client_only_server_mods",
          "禁用后重新 start_current_server 验证"
        ]
      }, null, 2);
    }
  };
}

export function createDisableClientOnlyServerModsTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: disableClientOnlyServerModsToolInfo.name,
        description: disableClientOnlyServerModsToolInfo.description,
        parameters: objectSchema({
          modsPath: stringProperty,
          minConfidence: stringProperty,
          dryRun: { type: "boolean" }
        })
      }
    },
    execute: async (input) => {
      const modsPath = stringInput(input, "modsPath", "server/mods");
      const minConfidenceRaw = stringInput(input, "minConfidence", "medium").toLowerCase();
      const minConfidence: DetectionConfidence = minConfidenceRaw === "high" || minConfidenceRaw === "low" ? minConfidenceRaw : "medium";
      const dryRun = booleanInput(input, "dryRun", false);
      const rank = { high: 3, medium: 2, low: 1 } as const;
      const scan = await scanMods(ctx, modsPath, false);
      const targets = scan.clientOnly.filter((item) => rank[item.confidence] >= rank[minConfidence]);
      if (targets.length === 0) {
        return JSON.stringify(summaryPayload(scan, {
          disabled: [],
          minConfidence,
          dryRun,
          message: "没有达到置信度阈值的仅客户端模组需要禁用"
        }), null, 2);
      }

      if (!dryRun) {
        await requireConfirmation(ctx, {
          title: "禁用仅客户端模组",
          description: `Agent 准备将 ${targets.length} 个仅客户端模组重命名为 .jar.disabled（不删除）：${targets.slice(0, 8).map((item) => item.fileName).join(", ")}${targets.length > 8 ? " 等" : ""}。`,
          risk: "medium"
        });
      }

      const disabled: Array<{ from: string; to: string; confidence: DetectionConfidence; reasons: string[] }> = [];
      const skipped: Array<{ fileName: string; reason: string }> = [];
      for (const target of targets) {
        if (dryRun) {
          disabled.push({ from: target.relativePath, to: `${target.relativePath}.disabled`, confidence: target.confidence, reasons: target.reasons });
          continue;
        }
        const destination = `${target.absolutePath}.disabled`;
        try {
          await rename(target.absolutePath, destination);
          disabled.push({
            from: target.relativePath,
            to: `${target.relativePath}.disabled`,
            confidence: target.confidence,
            reasons: target.reasons
          });
        } catch (error) {
          skipped.push({ fileName: target.fileName, reason: error instanceof Error ? error.message : String(error) });
        }
      }

      return JSON.stringify(summaryPayload(scan, {
        minConfidence,
        dryRun,
        disabled,
        skipped,
        message: dryRun
          ? `预览：将禁用 ${disabled.length} 个仅客户端模组`
          : `已禁用 ${disabled.length} 个仅客户端模组${skipped.length ? `，跳过 ${skipped.length} 个` : ""}`
      }), null, 2);
    }
  };
}
