import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

export function normalizeUserPath(input?: string) {
  const raw = (input ?? ".").trim() || ".";
  if (raw.includes("\0")) {
    throw new Error("Path contains invalid characters");
  }
  const slashPath = raw.replaceAll("\\", "/");
  if (path.isAbsolute(slashPath) || /^[a-zA-Z]:/.test(slashPath)) {
    throw new Error("Absolute paths are not allowed");
  }
  const parts = slashPath.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error("Path traversal is not allowed");
  }
  return parts.join(path.sep);
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingParent(target: string) {
  let current = target;
  while (!(await exists(current))) {
    const next = path.dirname(current);
    if (next === current) {
      throw new Error("Unable to resolve existing parent directory");
    }
    current = next;
  }
  const info = await stat(current);
  return info.isDirectory() ? current : path.dirname(current);
}

function assertWithin(base: string, target: string) {
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path is outside of the allowed directory");
  }
}

export async function resolveWithin(baseDir: string, userPath?: string, options: { mustExist?: boolean } = {}) {
  const baseReal = await realpath(baseDir);
  const normalized = normalizeUserPath(userPath);
  const target = path.resolve(baseReal, normalized);
  assertWithin(baseReal, target);

  if (options.mustExist) {
    const targetReal = await realpath(target);
    assertWithin(baseReal, targetReal);
    return targetReal;
  }

  const existingParent = await nearestExistingParent(target);
  const parentReal = await realpath(existingParent);
  assertWithin(baseReal, parentReal);
  return target;
}
