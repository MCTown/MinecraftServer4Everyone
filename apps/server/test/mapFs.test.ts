import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  allowedMapDirectories,
  assertMapFileName,
  assertRelativePath,
  copyHandleToPath,
  createTempIn,
  entryPath,
  listExternalChunkFiles,
  mapFileExists,
  mapFilePattern,
  openMapDirectory,
  openMapFileIn,
  preserveFrom,
  removeFileIn,
  renameInto,
  requireLinux,
  sweepTempFiles,
  type MapDirectoryHandle
} from "../src/services/mapFs.js";

const linuxOnly = { skip: process.platform !== "linux" ? "mapFs is Linux-only" : false };
const roots: string[] = [];

async function makeBase() {
  const base = await mkdtemp(path.join(tmpdir(), "mapfs-"));
  roots.push(base);
  return base;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Creates `<base>/world/region` with the given files and returns an opened handle to it. */
async function makeRegionDir(files: Record<string, Buffer | string> = {}, directoryName = "region") {
  const base = await makeBase();
  const relative = path.posix.join("world", directoryName);
  const absolute = path.join(base, "world", directoryName);
  await mkdir(absolute, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(absolute, name), content);
  return { base, relative, absolute, directory: await openMapDirectory(base, relative) };
}

test("assertRelativePath accepts plain relative POSIX paths", () => {
  for (const value of ["world", "world/region", "world/region/r.0.0.mca", "a/b/c"]) {
    assert.doesNotThrow(() => assertRelativePath(value), value);
  }
});

test("assertRelativePath rejects traversal, absolute, backslash and NUL paths", () => {
  const rejected = [
    "",
    "/world",
    "/",
    "C:/world",
    "c:\\world",
    "world\\region",
    "..",
    "../world",
    "world/../../etc",
    "world/..",
    "./world",
    "world//region",
    "world\0/region"
  ];
  for (const value of rejected) assert.throws(() => assertRelativePath(value), /地图路径无效/, value);
});

test("assertRelativePath tolerates a trailing slash, which callers reject downstream", () => {
  // `path.posix.normalize` keeps the trailing slash, so this passes the syntactic check.
  // MapService.normalizeSelection is what rejects it, via its dirname/basename comparisons.
  assert.doesNotThrow(() => assertRelativePath("world/region/"));
});

test("mapFilePattern matches region files and mcc sidecars only", () => {
  for (const name of ["r.0.0.mca", "r.-1.31.mca", "c.0.0.mcc", "c.-5.9.mcc"]) {
    assert.ok(mapFilePattern.test(name), name);
  }
  for (const name of ["level.dat", "r.0.0.mca.tmp", "session.lock", "r.0.0.mcc", "c.0.0.mca", "../r.0.0.mca"]) {
    assert.equal(mapFilePattern.test(name), false, name);
  }
});

test("assertMapFileName returns the name it accepts and throws otherwise", () => {
  assert.equal(assertMapFileName("r.0.0.mca"), "r.0.0.mca");
  assert.throws(() => assertMapFileName("level.dat"), /不是受支持的地图文件：level.dat/);
});

test("allowedMapDirectories covers the three per-world data directories", () => {
  assert.deepEqual([...allowedMapDirectories], ["region", "poi", "entities"]);
});

test("requireLinux only passes on Linux", () => {
  if (process.platform === "linux") assert.doesNotThrow(() => requireLinux());
  else assert.throws(() => requireLinux(), /仅支持 Linux/);
});

test("preserveFrom keeps permission bits and drops the file type bits", () => {
  const attributes = preserveFrom({ mode: 0o100644, uid: 1_000, gid: 1_000, atime: new Date(0), mtime: new Date(1_000) });
  assert.equal(attributes.mode, 0o644);
  assert.equal(attributes.uid, 1_000);
  assert.equal(attributes.mtime.getTime(), 1_000);
});

test("openMapDirectory opens an allowed directory and reports its real path", linuxOnly, async () => {
  const { base, absolute, directory } = await makeRegionDir();
  try {
    assert.equal(directory.absolute, await stat(absolute).then(() => absolute));
    assert.equal(directory.base, base);
    assert.equal(directory.relative, "world/region");
    assert.ok(entryPath(directory, "r.0.0.mca").startsWith("/proc/self/fd/"));
  } finally {
    await directory.handle.close();
  }
});

test("openMapDirectory refuses directories outside the allow-list", linuxOnly, async () => {
  const base = await makeBase();
  await mkdir(path.join(base, "world", "playerdata"), { recursive: true });
  await assert.rejects(openMapDirectory(base, "world/playerdata"), /地图目录无效/);
});

test("openMapDirectory can be narrowed to a single directory name", linuxOnly, async () => {
  const { base, directory } = await makeRegionDir();
  await directory.handle.close();
  await assert.rejects(openMapDirectory(base, "world/region", ["poi"]), /地图目录无效/);
});

test("openMapDirectory rejects a symlinked directory even when it points inside the base", linuxOnly, async () => {
  const base = await makeBase();
  await mkdir(path.join(base, "world", "real"), { recursive: true });
  await symlink(path.join(base, "world", "real"), path.join(base, "world", "region"));
  // O_NOFOLLOW on the final component makes the symlink itself unopenable as a directory.
  await assert.rejects(openMapDirectory(base, "world/region"), /ELOOP|地图目录/);
});

test("openMapDirectory rejects a path escaping the base through a symlink", linuxOnly, async () => {
  const base = await makeBase();
  const outside = await makeBase();
  await mkdir(path.join(outside, "region"), { recursive: true });
  await mkdir(path.join(base, "world"), { recursive: true });
  await symlink(path.join(outside, "region"), path.join(base, "world", "region"));
  await assert.rejects(openMapDirectory(base, "world/region"), /ELOOP|地图目录|允许|outside/);
});

test("openMapFileIn opens a normal region file and rejects unsupported names", linuxOnly, async () => {
  const { directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(16), "level.dat": "x" });
  try {
    const opened = await openMapFileIn(directory, "r.0.0.mca");
    assert.equal(opened.info.size, 16);
    await opened.handle.close();
    await assert.rejects(openMapFileIn(directory, "level.dat"), /不是受支持的地图文件/);
  } finally {
    await directory.handle.close();
  }
});

test("openMapFileIn refuses a hard-linked file to avoid collateral writes", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(8) });
  try {
    await link(path.join(absolute, "r.0.0.mca"), path.join(absolute, "r.1.0.mca"));
    await assert.rejects(openMapFileIn(directory, "r.0.0.mca"), /存在硬链接/);
  } finally {
    await directory.handle.close();
  }
});

test("openMapFileIn refuses a symlinked region file", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(8) });
  try {
    await symlink(path.join(absolute, "r.0.0.mca"), path.join(absolute, "r.2.0.mca"));
    await assert.rejects(openMapFileIn(directory, "r.2.0.mca"), /ELOOP/);
  } finally {
    await directory.handle.close();
  }
});

test("openMapFileIn refuses a directory that happens to be named like a region file", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir();
  try {
    await mkdir(path.join(absolute, "r.3.3.mca"));
    await assert.rejects(openMapFileIn(directory, "r.3.3.mca"), /不是普通文件/);
  } finally {
    await directory.handle.close();
  }
});

test("mapFileExists reports presence without throwing on invalid names", linuxOnly, async () => {
  const { directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(1) });
  try {
    assert.equal(await mapFileExists(directory, "r.0.0.mca"), true);
    assert.equal(await mapFileExists(directory, "r.9.9.mca"), false);
    assert.equal(await mapFileExists(directory, "level.dat"), false);
  } finally {
    await directory.handle.close();
  }
});

test("copyHandleToPath reproduces content across chunk boundaries and preserves attributes", linuxOnly, async () => {
  const payload = Buffer.alloc(600 * 1_024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": payload });
  try {
    const opened = await openMapFileIn(directory, "r.0.0.mca");
    const attributes = preserveFrom(opened.info);
    const destination = path.join(absolute, "copy.bin");
    await copyHandleToPath(opened.handle, destination, opened.info.size, attributes);
    await opened.handle.close();
    assert.ok(payload.equals(await readFile(destination)));
    const copied = await stat(destination);
    assert.equal(copied.mode & 0o7777, attributes.mode);
    assert.equal(copied.mtime.getTime(), attributes.mtime.getTime());
  } finally {
    await directory.handle.close();
  }
});

test("copyHandleToPath refuses to overwrite an existing destination", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(4) });
  try {
    const destination = path.join(absolute, "taken.bin");
    await writeFile(destination, "existing");
    const opened = await openMapFileIn(directory, "r.0.0.mca");
    await assert.rejects(copyHandleToPath(opened.handle, destination, 4), /EEXIST/);
    await opened.handle.close();
    assert.equal(await readFile(destination, "utf8"), "existing");
  } finally {
    await directory.handle.close();
  }
});

test("copyHandleToPath fails loudly when the source is shorter than the declared size", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(64) });
  try {
    const opened = await openMapFileIn(directory, "r.0.0.mca");
    // Claiming more bytes than exist must not silently produce a truncated copy.
    await assert.rejects(copyHandleToPath(opened.handle, path.join(absolute, "short.bin"), 4_096), /文件在复制期间被截断/);
    await opened.handle.close();
  } finally {
    await directory.handle.close();
  }
});

test("createTempIn and renameInto atomically publish a new region file", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir();
  try {
    const temp = await createTempIn(directory);
    assert.ok(temp.name.startsWith(".map-tmp-"));
    const handle = await open(temp.target, "w");
    await handle.writeFile("payload");
    await handle.close();
    await renameInto(directory, temp.name, "r.4.4.mca");
    assert.equal(await readFile(path.join(absolute, "r.4.4.mca"), "utf8"), "payload");
    assert.deepEqual((await readdir(absolute)).filter((name) => name.startsWith(".map-tmp-")), []);
  } finally {
    await directory.handle.close();
  }
});

test("renameInto refuses a destination that is not a supported map file", linuxOnly, async () => {
  const { directory } = await makeRegionDir();
  try {
    const temp = await createTempIn(directory);
    const handle = await open(temp.target, "w");
    await handle.close();
    await assert.rejects(renameInto(directory, temp.name, "level.dat"), /不是受支持的地图文件/);
  } finally {
    await directory.handle.close();
  }
});

test("sweepTempFiles removes only leftover temp files", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(2), ".map-tmp-stale": "x", "keep.txt": "y" });
  try {
    await sweepTempFiles(directory);
    const remaining = (await readdir(absolute)).sort();
    assert.deepEqual(remaining, ["keep.txt", "r.0.0.mca"]);
  } finally {
    await directory.handle.close();
  }
});

test("removeFileIn deletes a region file and rejects unsupported targets", linuxOnly, async () => {
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(2), "level.dat": "keep" });
  try {
    await removeFileIn(directory, "r.0.0.mca");
    assert.equal(await mapFileExists(directory, "r.0.0.mca"), false);
    await assert.rejects(removeFileIn(directory, "level.dat"), /不是受支持的地图文件/);
    assert.equal(await readFile(path.join(absolute, "level.dat"), "utf8"), "keep");
  } finally {
    await directory.handle.close();
  }
});

test("listExternalChunkFiles selects only sidecars belonging to the region", linuxOnly, async () => {
  // Region (0,0) owns chunks 0..31; region (-1,0) owns -32..-1.
  const { directory } = await makeRegionDir({
    "c.0.0.mcc": "a",
    "c.31.31.mcc": "b",
    "c.32.0.mcc": "c",
    "c.-1.0.mcc": "d",
    "r.0.0.mca": Buffer.alloc(1),
    "notes.txt": "x"
  });
  try {
    assert.deepEqual(await listExternalChunkFiles(directory, 0, 0), ["c.0.0.mcc", "c.31.31.mcc"]);
    assert.deepEqual(await listExternalChunkFiles(directory, -1, 0), ["c.-1.0.mcc"]);
    assert.deepEqual(await listExternalChunkFiles(directory, 1, 0), ["c.32.0.mcc"]);
    assert.deepEqual(await listExternalChunkFiles(directory, 5, 5), []);
  } finally {
    await directory.handle.close();
  }
});

test("map directory handles stay usable after the directory is renamed on disk", linuxOnly, async () => {
  // The fd is pinned to the inode, so a rename must not break subsequent lookups.
  const { absolute, directory } = await makeRegionDir({ "r.0.0.mca": Buffer.alloc(3) });
  const moved = path.join(path.dirname(absolute), "region-moved");
  try {
    const { rename } = await import("node:fs/promises");
    await rename(absolute, moved);
    assert.equal(await mapFileExists(directory as MapDirectoryHandle, "r.0.0.mca"), true);
  } finally {
    await directory.handle.close();
  }
});
