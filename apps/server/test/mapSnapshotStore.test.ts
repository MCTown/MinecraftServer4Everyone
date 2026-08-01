import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appConfig } from "../src/config.js";
import { openMapDirectory, type MapDirectoryHandle } from "../src/services/mapFs.js";
import { MapSnapshotStore } from "../src/services/mapSnapshotStore.js";
import type { MapSnapshot } from "../src/types.js";

const linuxOnly = { skip: process.platform !== "linux" ? "MapSnapshotStore is Linux-only" : false };
const serverId = "snap-server";
const roots: string[] = [];

before(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "snapshot-store-"));
  roots.push(root);
  appConfig.mapSnapshotsDir = root;
});

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Creates a world directory with the given region files and returns an opened handle. */
async function worldWith(files: Record<string, Buffer | string>): Promise<{ base: string; directory: MapDirectoryHandle }> {
  const base = await mkdtemp(path.join(tmpdir(), "snapshot-world-"));
  roots.push(base);
  const regionDir = path.join(base, "world", "region");
  await mkdir(regionDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(regionDir, name), content);
  return { base, directory: await openMapDirectory(base, "world/region") };
}

function sources(directory: MapDirectoryHandle, names: string[]) {
  return names.map((name) => ({ path: `world/region/${name}`, directory, fileName: name }));
}

/** Polls until `check` passes; used for cleanup that runs detached from the stream close. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

test("assertServerId and assertSnapshotId gate every path helper", () => {
  const store = new MapSnapshotStore();
  assert.throws(() => store.root("bad/id"), /服务端标识无效/);
  assert.throws(() => store.root(".."), /服务端标识无效/);
  assert.throws(() => store.root("a".repeat(65)), /服务端标识无效/);
  assert.ok(store.root("valid_id-1").endsWith("valid_id-1"));
  assert.throws(() => store.backupPath(serverId, "not-a-uuid", "0-r.0.0.mca"), /快照标识无效/);
});

test("backupPath only accepts generated backup names", () => {
  const store = new MapSnapshotStore();
  const id = "00000000-0000-4000-8000-000000000000";
  assert.ok(store.backupPath(serverId, id, "0-r.0.0.mca").endsWith(path.join(id, "files", "0-r.0.0.mca")));
  assert.ok(store.backupPath(serverId, id, "12-c.-1.5.mcc").includes("12-c.-1.5.mcc"));
  for (const name of ["r.0.0.mca", "0-level.dat", "../0-r.0.0.mca", "0000-r.0.0.mca", "0-r.0.0.mca.bak"]) {
    assert.throws(() => store.backupPath(serverId, id, name), /快照文件名无效/, name);
  }
});

test("create copies present files and records absent ones as missing", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": Buffer.from("region-bytes") });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca", "r.1.1.mca"]), "manual", "名称", " 说明 ");
    assert.equal(snapshot.serverId, serverId);
    assert.equal(snapshot.reason, "manual");
    assert.equal(snapshot.name, "名称");
    assert.equal(snapshot.description, "说明");
    assert.equal(snapshot.rollbackConfirmationPhrase, `回滚快照 ${snapshot.id}`);
    assert.equal(snapshot.deleteConfirmationPhrase, `删除快照 ${snapshot.id}`);

    const [present, absent] = snapshot.files;
    assert.equal(present!.missing, false);
    assert.equal(present!.backupName, "0-r.0.0.mca");
    assert.equal(present!.size, 12);
    assert.equal(absent!.missing, true);
    assert.equal(absent!.backupName, "");

    const backup = await readFile(store.backupPath(serverId, snapshot.id, present!.backupName), "utf8");
    assert.equal(backup, "region-bytes");
    // Only the present file gets a backup blob on disk.
    assert.deepEqual(await readdir(path.join(store.root(serverId), snapshot.id, "files")), ["0-r.0.0.mca"]);
  } finally {
    await directory.handle.close();
  }
});

test("create falls back to a generated name when none is given", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "delete", "   ", "");
    assert.match(snapshot.name, /^地图快照 /);
    assert.equal(snapshot.description, "");
  } finally {
    await directory.handle.close();
  }
});

test("create rejects an empty or oversized source list", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    await assert.rejects(store.create(serverId, [], "manual", "", ""), /至少需要一个目标文件/);
    const many = Array.from({ length: 257 }, (_, index) => ({
      path: `world/region/r.${index}.0.mca`,
      directory,
      fileName: `r.${index}.0.mca`
    }));
    await assert.rejects(store.create(serverId, many, "manual", "", ""), /最多包含 256 个文件/);
  } finally {
    await directory.handle.close();
  }
});

test("read validates metadata and rejects tampered paths", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "", "");
    const metadataPath = path.join(store.root(serverId), snapshot.id, "metadata.json");

    const rewrite = async (mutate: (value: MapSnapshot) => void) => {
      const value = JSON.parse(await readFile(metadataPath, "utf8")) as MapSnapshot;
      mutate(value);
      await writeFile(metadataPath, JSON.stringify(value));
    };

    await rewrite((value) => { value.files[0]!.path = "world/region/../../etc/passwd"; });
    await assert.rejects(store.read(serverId, snapshot.id), /地图路径无效/);

    await rewrite((value) => { value.files[0]!.path = "world/region/level.dat"; });
    await assert.rejects(store.read(serverId, snapshot.id), /快照路径无效/);

    await rewrite((value) => { value.files[0]!.path = "world/playerdata/r.0.0.mca"; });
    await assert.rejects(store.read(serverId, snapshot.id), /快照路径无效/);

    await rewrite((value) => {
      value.files[0]!.path = "world/region/r.0.0.mca";
      value.files[0]!.backupName = "../../escape";
    });
    await assert.rejects(store.read(serverId, snapshot.id), /快照文件名无效/);

    await rewrite((value) => { value.serverId = "someone-else"; });
    await assert.rejects(store.read(serverId, snapshot.id), /快照元数据无效/);
  } finally {
    await directory.handle.close();
  }
});

test("read rejects a missing entry that still claims a backup file", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "", "");
    const metadataPath = path.join(store.root(serverId), snapshot.id, "metadata.json");
    const value = JSON.parse(await readFile(metadataPath, "utf8")) as MapSnapshot;
    value.files[0]!.missing = true;
    await writeFile(metadataPath, JSON.stringify(value));
    await assert.rejects(store.read(serverId, snapshot.id), /快照元数据无效/);
  } finally {
    await directory.handle.close();
  }
});

test("read reports a missing snapshot directory clearly", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  await assert.rejects(store.read(serverId, "11111111-2222-4333-8444-555555555555"), /快照不存在或元数据缺失/);
});

test("list skips directories that are not complete snapshots", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "kept", "");
    // A UUID-named directory with no metadata, plus a non-UUID directory: both ignored.
    await mkdir(path.join(store.root(serverId), "99999999-8888-4777-8666-555555555555"), { recursive: true });
    await mkdir(path.join(store.root(serverId), "exports"), { recursive: true });
    const listed = await store.list(serverId);
    assert.deepEqual(listed.filter((item) => item.id === snapshot.id).length, 1);
    assert.equal(listed.every((item) => item.files.length > 0), true);
  } finally {
    await directory.handle.close();
  }
});

test("list returns an empty array when the server has no snapshot directory", async () => {
  const store = new MapSnapshotStore();
  assert.deepEqual(await store.list("never-used"), []);
});

test("prune keeps the retention limit and never removes protected snapshots", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const pruneServer = "prune-server";
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const ids: string[] = [];
    for (let index = 0; index < 23; index += 1) {
      const snapshot = await store.create(pruneServer, sources(directory, ["r.0.0.mca"]), "manual", `s${index}`, "");
      ids.push(snapshot.id);
      // Metadata sorts by createdAt; nudge it so ordering is deterministic.
      const metadataPath = path.join(store.root(pruneServer), snapshot.id, "metadata.json");
      const value = JSON.parse(await readFile(metadataPath, "utf8")) as MapSnapshot;
      value.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      await writeFile(metadataPath, JSON.stringify(value));
    }

    const protectedId = ids[0]!;
    const removed = await store.prune(pruneServer, [protectedId]);
    const remaining = await store.list(pruneServer);
    // 20 slots total, one reserved for the protected id.
    assert.equal(remaining.length, 20);
    assert.ok(remaining.some((snapshot) => snapshot.id === protectedId));
    assert.equal(removed.includes(protectedId), false);
    assert.equal(removed.length, 3);
  } finally {
    await directory.handle.close();
  }
});

test("remove deletes a snapshot directory and is idempotent", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "", "");
    await store.remove(serverId, snapshot.id);
    await assert.rejects(store.read(serverId, snapshot.id), /快照不存在/);
    await store.remove(serverId, snapshot.id);
  } finally {
    await directory.handle.close();
  }
});

test("openBackup returns a readable handle for a stored blob", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "payload-bytes" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "", "");
    const backup = await store.openBackup(serverId, snapshot.id, snapshot.files[0]!.backupName);
    try {
      assert.equal(backup.info.size, 13);
      const buffer = Buffer.alloc(13);
      await backup.handle.read(buffer, 0, 13, 0);
      assert.equal(buffer.toString("utf8"), "payload-bytes");
    } finally {
      await backup.handle.close();
    }
    await assert.rejects(store.openBackup(serverId, snapshot.id, "0-r.9.9.mca"), /ENOENT/);
  } finally {
    await directory.handle.close();
  }
});

test("openExport writes a unique archive per call and cleans it up after streaming", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "archive", "");
    const first = await store.openExport(serverId, snapshot);
    const second = await store.openExport(serverId, snapshot);
    const exportsRoot = path.join(store.root(serverId), "exports");
    assert.equal((await readdir(exportsRoot)).length, 2);

    for (const file of [first, second]) {
      await new Promise((resolve, reject) => {
        file.stream.on("data", () => undefined);
        file.stream.on("close", resolve);
        file.stream.on("error", reject);
      });
    }
    // The close handler removes each archive, but does so without awaiting, so poll.
    await waitFor(async () => (await readdir(exportsRoot)).length === 0);
    assert.deepEqual(await readdir(exportsRoot), []);
  } finally {
    await directory.handle.close();
  }
});

test("openExport sanitises the download filename", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const { directory } = await worldWith({ "r.0.0.mca": "x" });
  try {
    const snapshot = await store.create(serverId, sources(directory, ["r.0.0.mca"]), "manual", "../../etc/passwd", "");
    const file = await store.openExport(serverId, snapshot);
    assert.equal(file.fileName, ".._.._etc_passwd.tar.gz");
    assert.equal(file.fileName.includes("/"), false);
    file.stream.destroy();
  } finally {
    await directory.handle.close();
  }
});

test("sweepExports only drops archives older than the cutoff", linuxOnly, async () => {
  const store = new MapSnapshotStore();
  const exportsRoot = path.join(store.root(serverId), "exports");
  await mkdir(exportsRoot, { recursive: true });
  const stale = path.join(exportsRoot, "stale.tar.gz");
  const fresh = path.join(exportsRoot, "fresh.tar.gz");
  const other = path.join(exportsRoot, "notes.txt");
  await writeFile(stale, "old");
  await writeFile(fresh, "new");
  await writeFile(other, "keep");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(stale, twoHoursAgo, twoHoursAgo);

  await store.sweepExports(serverId);
  const remaining = (await readdir(exportsRoot)).sort();
  assert.deepEqual(remaining, ["fresh.tar.gz", "notes.txt"]);
});

test("sweepExports is a no-op when no exports directory exists", async () => {
  const store = new MapSnapshotStore();
  await store.sweepExports("never-exported");
});
