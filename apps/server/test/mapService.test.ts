import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { headerSize, sectorSize } from "../src/services/mapAnvil.js";
import type { MapMutationSelection } from "../src/types.js";
import { cleanupTempRoots, createHarness, useTempSnapshotRoot, type Harness } from "./helpers/mapHarness.js";
import { buildRegionFile, encodeNbt, nbtCompound, nbtInt, nbtList, uniformSection } from "./helpers/nbt.js";

const linuxOnly = { skip: process.platform !== "linux" ? "MapService is Linux-only" : false };

before(async () => {
  await useTempSnapshotRoot();
});

after(async () => {
  await cleanupTempRoots();
});

const chunkNbt = encodeNbt(nbtCompound({
  DataVersion: nbtInt(3_465),
  sections: nbtList([uniformSection(0, "minecraft:stone")])
}));

function selection(overrides: Partial<MapMutationSelection> = {}): MapMutationSelection {
  return {
    regionPath: "world/region",
    regionFilePath: "world/region/r.0.0.mca",
    mode: "chunks",
    chunks: [{ localX: 1, localZ: 2 }],
    ...overrides
  };
}

/** Reads the location entry for a chunk straight out of the on-disk header. */
async function headerEntry(regionDir: string, name: string, localX: number, localZ: number) {
  const buffer = await readFile(path.join(regionDir, name));
  const offset = (localZ * 32 + localX) * 4;
  return {
    sectorOffset: buffer.readUIntBE(offset, 3),
    sectorCount: buffer[offset + 3]!,
    timestamp: buffer.readUInt32BE(sectorSize + offset)
  };
}

async function standardWorld(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const harness = await createHarness(options);
  const region = buildRegionFile([
    { localX: 1, localZ: 2, nbt: chunkNbt },
    { localX: 3, localZ: 4, nbt: chunkNbt }
  ]);
  await writeFile(path.join(harness.regionDir, "r.0.0.mca"), region);
  return harness;
}

test("planMutation produces a phrase bound to the exact selection", linuxOnly, async () => {
  const harness = await standardWorld();
  const plan = await harness.service.planMutation(harness.serverId, selection());
  assert.equal(plan.mode, "chunks");
  assert.equal(plan.affectedChunkCount, 1);
  assert.deepEqual(plan.affectedPaths, ["world/region/r.0.0.mca"]);
  assert.deepEqual(plan.externalChunkFiles, []);
  assert.equal(plan.requiresStoppedServer, true);
  assert.equal(plan.serverStatus, "stopped");
  assert.match(plan.confirmationPhrase, /^删除 1 个区块：world\/region\/r\.0\.0\.mca #[0-9a-f]{8}$/);
  assert.equal(plan.selectionToken.length, 8);
});

test("planMutation tokens differ between same-size selections", linuxOnly, async () => {
  const harness = await standardWorld();
  const first = await harness.service.planMutation(harness.serverId, selection({ chunks: [{ localX: 1, localZ: 2 }] }));
  const second = await harness.service.planMutation(harness.serverId, selection({ chunks: [{ localX: 3, localZ: 4 }] }));
  assert.notEqual(first.selectionToken, second.selectionToken);
  assert.notEqual(first.confirmationPhrase, second.confirmationPhrase);
});

test("planMutation is stable regardless of chunk order and duplicates", linuxOnly, async () => {
  const harness = await standardWorld();
  const ordered = await harness.service.planMutation(harness.serverId, selection({ chunks: [{ localX: 1, localZ: 2 }, { localX: 3, localZ: 4 }] }));
  const shuffled = await harness.service.planMutation(harness.serverId, selection({
    chunks: [{ localX: 3, localZ: 4 }, { localX: 1, localZ: 2 }, { localX: 1, localZ: 2 }]
  }));
  assert.equal(ordered.selectionToken, shuffled.selectionToken);
  assert.equal(shuffled.affectedChunkCount, 2);
});

test("planMutation reports a whole-region delete with a null chunk count", linuxOnly, async () => {
  const harness = await standardWorld();
  const plan = await harness.service.planMutation(harness.serverId, selection({ mode: "region", chunks: undefined }));
  assert.equal(plan.affectedChunkCount, null);
  assert.match(plan.confirmationPhrase, /^删除 整个区域：world\/region\/r\.0\.0\.mca #[0-9a-f]{8}$/);
});

test("planMutation expands a rectangle into its chunk count", linuxOnly, async () => {
  const harness = await standardWorld();
  const plan = await harness.service.planMutation(harness.serverId, selection({
    mode: "rectangle",
    chunks: undefined,
    rectangle: { minX: 0, minZ: 0, maxX: 2, maxZ: 3 }
  }));
  assert.equal(plan.affectedChunkCount, 12);
});

test("planMutation includes sibling poi/entities files and matching mcc sidecars", linuxOnly, async () => {
  const harness = await standardWorld({ siblings: ["poi", "entities"] });
  const poi = path.join(harness.base, "world", "poi");
  const entities = path.join(harness.base, "world", "entities");
  await writeFile(path.join(poi, "r.0.0.mca"), buildRegionFile([{ localX: 1, localZ: 2, nbt: chunkNbt }]));
  await writeFile(path.join(entities, "r.0.0.mca"), buildRegionFile([{ localX: 1, localZ: 2, nbt: chunkNbt }]));
  // Chunk (1,2) of region (0,0) is absolute chunk (1,2); the other sidecar belongs elsewhere.
  await writeFile(path.join(harness.regionDir, "c.1.2.mcc"), "payload");
  await writeFile(path.join(harness.regionDir, "c.5.5.mcc"), "unrelated");

  const plan = await harness.service.planMutation(harness.serverId, selection());
  assert.deepEqual(plan.affectedPaths.sort(), [
    "world/entities/r.0.0.mca",
    "world/poi/r.0.0.mca",
    "world/region/r.0.0.mca"
  ]);
  assert.deepEqual(plan.externalChunkFiles, ["world/region/c.1.2.mcc"]);
});

test("planMutation rejects malformed selections", linuxOnly, async () => {
  const harness = await standardWorld();
  const cases: Array<[string, MapMutationSelection, RegExp]> = [
    ["non-region directory", selection({ regionPath: "world/poi", regionFilePath: "world/poi/r.0.0.mca" }), /不是 region 目录/],
    ["file outside the directory", selection({ regionFilePath: "world/other/r.0.0.mca" }), /不属于所选 region 目录/],
    ["invalid region file name", selection({ regionFilePath: "world/region/level.dat" }), /区域文件路径无效/],
    ["empty chunk list", selection({ chunks: [] }), /至少选择一个区块/],
    ["missing rectangle", selection({ mode: "rectangle", chunks: undefined }), /矩形选择无效/],
    ["inverted rectangle", selection({ mode: "rectangle", chunks: undefined, rectangle: { minX: 5, minZ: 0, maxX: 1, maxZ: 3 } }), /起点必须不大于终点/],
    ["out-of-range chunk", selection({ chunks: [{ localX: 32, localZ: 0 }] }), /区块坐标超出区域范围/],
    ["negative chunk", selection({ chunks: [{ localX: -1, localZ: 0 }] }), /区块坐标超出区域范围/],
    ["absolute path", selection({ regionPath: "/world/region", regionFilePath: "/world/region/r.0.0.mca" }), /地图路径无效/],
    ["traversal path", selection({ regionPath: "world/../region", regionFilePath: "world/../region/r.0.0.mca" }), /地图路径无效/]
  ];
  for (const [label, input, pattern] of cases) {
    await assert.rejects(harness.service.planMutation(harness.serverId, input), pattern, label);
  }
});

test("planMutation refuses more chunks than the per-call cap", linuxOnly, async () => {
  const harness = await standardWorld();
  const chunks = Array.from({ length: 1_025 }, (_, index) => ({ localX: index % 32, localZ: Math.floor(index / 32) % 32 }));
  await assert.rejects(harness.service.planMutation(harness.serverId, selection({ chunks })), /单次最多选择 1024 个区块/);
});

test("planMutation fails when the region file is absent", linuxOnly, async () => {
  const harness = await createHarness();
  await assert.rejects(harness.service.planMutation(harness.serverId, selection()), /目标区域文件不存在/);
});

test("planMutation still works while the server is running, but flags the status", linuxOnly, async () => {
  const harness = await standardWorld({ status: "running" });
  const plan = await harness.service.planMutation(harness.serverId, selection());
  assert.equal(plan.serverStatus, "running");
  assert.equal(plan.requiresStoppedServer, true);
});

test("deleteSelection requires the server to be stopped", linuxOnly, async () => {
  const harness = await standardWorld({ status: "running" });
  const plan = await harness.service.planMutation(harness.serverId, selection());
  await assert.rejects(
    harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", ""),
    /要求服务端状态严格为已停止/
  );
  // Nothing was touched.
  assert.deepEqual(await headerEntry(harness.regionDir, "r.0.0.mca", 1, 2), { sectorOffset: 2, sectorCount: 1, timestamp: 1_700_000_000 });
});

test("deleteSelection refuses when a stray process is still attached", linuxOnly, async () => {
  const harness = await standardWorld();
  const plan = await harness.service.planMutation(harness.serverId, selection());
  harness.setHasProcesses(true);
  await assert.rejects(
    harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", ""),
    /仍有活动进程/
  );
  harness.setHasProcesses(false);
  harness.setActive(harness.serverId);
  await assert.rejects(
    harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", ""),
    /仍有活动进程/
  );
});

test("deleteSelection rejects a phrase generated for a different selection", linuxOnly, async () => {
  const harness = await standardWorld();
  const otherPlan = await harness.service.planMutation(harness.serverId, selection({ chunks: [{ localX: 3, localZ: 4 }] }));
  await assert.rejects(
    harness.service.deleteSelection(harness.serverId, selection(), otherPlan.confirmationPhrase, "", ""),
    /确认词与本次选择不匹配/
  );
  await assert.rejects(harness.service.deleteSelection(harness.serverId, selection(), "", "", ""), /确认词与本次选择不匹配/);
});

test("deleteSelection zeroes only the selected header entries and keeps the file otherwise intact", linuxOnly, async () => {
  const harness = await standardWorld();
  const before = await readFile(path.join(harness.regionDir, "r.0.0.mca"));
  const plan = await harness.service.planMutation(harness.serverId, selection());
  const result = await harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "删除测试", "说明");

  assert.equal(result.ok, true);
  assert.deepEqual(result.appliedPaths, ["world/region/r.0.0.mca"]);
  assert.equal(harness.exclusiveCalls() > 0, true);

  assert.deepEqual(await headerEntry(harness.regionDir, "r.0.0.mca", 1, 2), { sectorOffset: 0, sectorCount: 0, timestamp: 0 });
  // The untouched chunk keeps its allocation and timestamp.
  assert.deepEqual(await headerEntry(harness.regionDir, "r.0.0.mca", 3, 4), { sectorOffset: 3, sectorCount: 1, timestamp: 1_700_000_000 });

  const after = await readFile(path.join(harness.regionDir, "r.0.0.mca"));
  assert.equal(after.length, before.length);
  // Payload sectors are deliberately left in place for Minecraft to reclaim.
  assert.ok(after.subarray(headerSize).equals(before.subarray(headerSize)));
});

test("deleteSelection preserves file mode and creates a restorable snapshot", linuxOnly, async () => {
  const harness = await standardWorld();
  const target = path.join(harness.regionDir, "r.0.0.mca");
  const before = await stat(target);
  const original = await readFile(target);
  const plan = await harness.service.planMutation(harness.serverId, selection());
  const result = await harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "snap", "desc");

  const after = await stat(target);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.equal(result.snapshot.reason, "delete");
  assert.equal(result.snapshot.name, "snap");
  assert.deepEqual(result.snapshot.files.map((file) => file.path), ["world/region/r.0.0.mca"]);
  assert.equal(result.snapshot.files[0]!.missing, false);

  const rollback = await harness.service.rollbackSnapshot(harness.serverId, result.snapshot.id, result.snapshot.rollbackConfirmationPhrase);
  assert.equal(rollback.ok, true);
  assert.ok((await readFile(target)).equals(original));
});

test("deleteSelection leaves empty poi and entities files untouched for chunk deletes", linuxOnly, async () => {
  const harness = await standardWorld({ siblings: ["poi", "entities"] });
  const poiTarget = path.join(harness.base, "world", "poi", "r.0.0.mca");
  const entitiesTarget = path.join(harness.base, "world", "entities", "r.0.0.mca");
  await writeFile(poiTarget, Buffer.alloc(0));
  await writeFile(entitiesTarget, Buffer.alloc(0));

  const plan = await harness.service.planMutation(harness.serverId, selection());
  const result = await harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", "");

  assert.deepEqual(result.appliedPaths, ["world/region/r.0.0.mca"]);
  assert.equal((await stat(poiTarget)).size, 0);
  assert.equal((await stat(entitiesTarget)).size, 0);
  assert.deepEqual(result.snapshot.files.map((file) => file.path), [
    "world/region/r.0.0.mca",
    "world/poi/r.0.0.mca",
    "world/entities/r.0.0.mca"
  ]);
});

test("whole-region deletes still remove empty sibling files", linuxOnly, async () => {
  const harness = await standardWorld({ siblings: ["poi"] });
  await writeFile(path.join(harness.base, "world", "poi", "r.0.0.mca"), Buffer.alloc(0));

  const wholeRegion = selection({ mode: "region", chunks: undefined });
  const plan = await harness.service.planMutation(harness.serverId, wholeRegion);
  await harness.service.deleteSelection(harness.serverId, wholeRegion, plan.confirmationPhrase, "", "");

  assert.deepEqual(await readdir(harness.regionDir), []);
  assert.deepEqual(await readdir(path.join(harness.base, "world", "poi")), []);
});

test("deleteSelection in region mode removes the file and rollback recreates it", linuxOnly, async () => {
  const harness = await standardWorld();
  const target = path.join(harness.regionDir, "r.0.0.mca");
  const original = await readFile(target);
  const wholeRegion = selection({ mode: "region", chunks: undefined });
  const plan = await harness.service.planMutation(harness.serverId, wholeRegion);
  const result = await harness.service.deleteSelection(harness.serverId, wholeRegion, plan.confirmationPhrase, "", "");

  assert.deepEqual(await readdir(harness.regionDir), []);
  const rollback = await harness.service.rollbackSnapshot(harness.serverId, result.snapshot.id, result.snapshot.rollbackConfirmationPhrase);
  assert.ok((await readFile(target)).equals(original));
  // The safety snapshot recorded the file as absent so the rollback itself stays reversible.
  assert.equal(rollback.safetySnapshot.files[0]!.missing, true);

  const undo = await harness.service.rollbackSnapshot(harness.serverId, rollback.safetySnapshot.id, rollback.safetySnapshot.rollbackConfirmationPhrase);
  assert.equal(undo.ok, true);
  assert.deepEqual(await readdir(harness.regionDir), []);
});

test("deleteSelection removes matching mcc sidecars only", linuxOnly, async () => {
  const harness = await standardWorld();
  await writeFile(path.join(harness.regionDir, "c.1.2.mcc"), "selected");
  await writeFile(path.join(harness.regionDir, "c.3.4.mcc"), "other");
  const plan = await harness.service.planMutation(harness.serverId, selection());
  await harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", "");

  const remaining = (await readdir(harness.regionDir)).sort();
  assert.deepEqual(remaining, ["c.3.4.mcc", "r.0.0.mca"]);
});

test("deleteSelection cleans up leftover temp files before writing", linuxOnly, async () => {
  const harness = await standardWorld();
  await writeFile(path.join(harness.regionDir, ".map-tmp-crashed"), "stale");
  const plan = await harness.service.planMutation(harness.serverId, selection());
  await harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", "");
  assert.deepEqual((await readdir(harness.regionDir)).filter((name) => name.startsWith(".map-tmp-")), []);
});

test("deleteSelection fails and leaves the file untouched when the header is too short", linuxOnly, async () => {
  const harness = await createHarness();
  // A 4 KiB file cannot hold the 8 KiB header, so the patch must abort.
  const stub = Buffer.alloc(sectorSize, 7);
  await writeFile(path.join(harness.regionDir, "r.0.0.mca"), stub);
  const plan = await harness.service.planMutation(harness.serverId, selection());
  await assert.rejects(
    harness.service.deleteSelection(harness.serverId, selection(), plan.confirmationPhrase, "", ""),
    /文件头不足 8192 字节/
  );
  assert.ok((await readFile(path.join(harness.regionDir, "r.0.0.mca"))).equals(stub));
});

test("previewChunk decodes a generated chunk and reports ungenerated ones", linuxOnly, async () => {
  const harness = await standardWorld();
  const preview = await harness.service.previewChunk(harness.serverId, "world/region/r.0.0.mca", 1, 2);
  assert.equal(preview.unsupportedReason, null);
  assert.equal(preview.cells.length, 256);
  assert.equal(preview.cells[0]!.block, "minecraft:stone");
  assert.equal(preview.chunkX, 1);
  assert.equal(preview.chunkZ, 2);

  const empty = await harness.service.previewChunk(harness.serverId, "world/region/r.0.0.mca", 10, 10);
  assert.equal(empty.unsupportedReason, "该区块尚未生成");
  assert.deepEqual(empty.cells, []);
});

test("previewChunk reports an unreadable chunk instead of throwing", linuxOnly, async () => {
  const harness = await createHarness();
  // Compression id 9 does not exist, so decompression must fail gracefully.
  await writeFile(path.join(harness.regionDir, "r.0.0.mca"), buildRegionFile([
    { localX: 0, localZ: 0, raw: Buffer.from("garbage"), compression: 9 }
  ]));
  const preview = await harness.service.previewChunk(harness.serverId, "world/region/r.0.0.mca", 0, 0);
  assert.match(preview.unsupportedReason ?? "", /不支持的区块压缩类型：9/);
});

test("previewChunk refuses paths and coordinates outside the supported range", linuxOnly, async () => {
  const harness = await standardWorld();
  await assert.rejects(harness.service.previewChunk(harness.serverId, "world/region/level.dat", 0, 0), /不是受支持的地图文件/);
  await assert.rejects(harness.service.previewChunk(harness.serverId, "world/region/r.0.0.mca", 32, 0), /区块坐标超出区域范围/);
  await assert.rejects(harness.service.previewChunk(harness.serverId, "../escape/r.0.0.mca", 0, 0), /地图路径无效/);
});

test("previewChunk rejects an allocation pointing past the end of the file", linuxOnly, async () => {
  const harness = await createHarness();
  await writeFile(path.join(harness.regionDir, "r.0.0.mca"), buildRegionFile([
    { localX: 0, localZ: 0, nbt: chunkNbt, header: { sectorOffset: 900, sectorCount: 1 } }
  ]));
  await assert.rejects(harness.service.previewChunk(harness.serverId, "world/region/r.0.0.mca", 0, 0), /区块分配超出 MCA 文件范围/);
});

test("createManualSnapshot captures the whole region regardless of the requested mode", linuxOnly, async () => {
  const harness = await standardWorld();
  const snapshot = await harness.service.createManualSnapshot(harness.serverId, selection(), "手动快照", "备份");
  assert.equal(snapshot.reason, "manual");
  assert.equal(snapshot.name, "手动快照");
  assert.deepEqual(snapshot.files.map((file) => file.path), ["world/region/r.0.0.mca"]);
});

test("createManualSnapshot requires a stopped server", linuxOnly, async () => {
  const harness = await standardWorld({ status: "running" });
  await assert.rejects(harness.service.createManualSnapshot(harness.serverId, selection(), "", ""), /要求服务端状态严格为已停止/);
});

test("listSnapshots returns newest first and getSnapshot round-trips metadata", linuxOnly, async () => {
  const harness = await standardWorld();
  const first = await harness.service.createManualSnapshot(harness.serverId, selection(), "first", "");
  const second = await harness.service.createManualSnapshot(harness.serverId, selection(), "second", "");
  const listed = await harness.service.listSnapshots(harness.serverId);
  assert.ok(listed.length >= 2);
  assert.deepEqual(
    [...listed].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((snapshot) => snapshot.id),
    listed.map((snapshot) => snapshot.id)
  );
  assert.equal((await harness.service.getSnapshot(harness.serverId, first.id)).name, "first");
  assert.equal((await harness.service.getSnapshot(harness.serverId, second.id)).name, "second");
});

test("rollbackSnapshot and deleteSnapshot enforce their own phrases", linuxOnly, async () => {
  const harness = await standardWorld();
  const snapshot = await harness.service.createManualSnapshot(harness.serverId, selection(), "phrase", "");
  await assert.rejects(harness.service.rollbackSnapshot(harness.serverId, snapshot.id, "回滚快照 wrong"), /回滚确认词不匹配/);
  await assert.rejects(harness.service.deleteSnapshot(harness.serverId, snapshot.id, "删除快照 wrong"), /删除快照确认词不匹配/);
  assert.equal(snapshot.rollbackConfirmationPhrase, `回滚快照 ${snapshot.id}`);
  assert.equal(snapshot.deleteConfirmationPhrase, `删除快照 ${snapshot.id}`);

  await harness.service.deleteSnapshot(harness.serverId, snapshot.id, snapshot.deleteConfirmationPhrase);
  await assert.rejects(harness.service.getSnapshot(harness.serverId, snapshot.id), /快照不存在/);
});

test("rollbackSnapshot requires a stopped server", linuxOnly, async () => {
  const harness = await standardWorld();
  const snapshot = await harness.service.createManualSnapshot(harness.serverId, selection(), "", "");
  harness.setStatus("running");
  await assert.rejects(
    harness.service.rollbackSnapshot(harness.serverId, snapshot.id, snapshot.rollbackConfirmationPhrase),
    /要求服务端状态严格为已停止/
  );
});

test("getSnapshot rejects a syntactically invalid snapshot id", linuxOnly, async () => {
  const harness = await standardWorld();
  await assert.rejects(harness.service.getSnapshot(harness.serverId, "../escape"), /快照标识无效/);
  await assert.rejects(harness.service.getSnapshot(harness.serverId, "not-a-uuid"), /快照标识无效/);
});

test("openExport produces a readable archive of the snapshot", linuxOnly, async () => {
  const harness = await standardWorld();
  const snapshot = await harness.service.createManualSnapshot(harness.serverId, selection(), "导出 / 测试", "");
  const file = await harness.service.openExport(harness.serverId, snapshot.id);
  assert.ok(file.size > 0);
  // The unsafe run " / " collapses to a single underscore.
  assert.equal(file.fileName, "导出_测试.tar.gz");
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(chunk as Buffer);
  // gzip magic number.
  assert.deepEqual([...Buffer.concat(chunks).subarray(0, 2)], [0x1f, 0x8b]);
});

test("operations on an unknown server id are rejected", linuxOnly, async () => {
  const harness = await standardWorld();
  await assert.rejects(harness.service.planMutation("nope", selection()), /Server not found/);
  await assert.rejects(harness.service.listSnapshots("nope"), /Server not found/);
});
