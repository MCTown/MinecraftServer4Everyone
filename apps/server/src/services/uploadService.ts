import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { eq } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { uploads } from "../db/schema.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

function safeFileName(name: string) {
  return path.basename(name).replace(/[<>:"/\\|?*]/g, "_") || "upload.bin";
}

export class UploadService {
  async save(sessionId: string, file: MultipartFile) {
    const id = createId("upload");
    const fileName = `${id}_${safeFileName(file.filename)}`;
    const dir = path.join(appConfig.tempUploadsDir, sessionId);
    await mkdir(dir, { recursive: true });
    const storedPath = path.join(dir, fileName);
    await pipeline(file.file, createWriteStream(storedPath));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const row: typeof uploads.$inferInsert = {
      id,
      sessionId,
      originalName: file.filename,
      storedPath,
      size: Number(file.file.bytesRead ?? 0),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    getDb().insert(uploads).values(row).run();
    return row;
  }

  list(sessionId: string) {
    return getDb().select().from(uploads).where(eq(uploads.sessionId, sessionId)).all();
  }

  requireUpload(id: string) {
    const upload = getDb().select().from(uploads).where(eq(uploads.id, id)).get();
    if (!upload) throw new Error("Upload not found");
    return upload;
  }

  requireSessionUpload(sessionId: string, id: string) {
    const upload = this.requireUpload(id);
    if (upload.sessionId !== sessionId) throw new Error("Upload does not belong to current session");
    return upload;
  }

  cleanupExpired() {
    const now = nowIso();
    const expired = getDb().select().from(uploads).all().filter((upload) => upload.expiresAt < now);
    for (const upload of expired) {
      rm(upload.storedPath, { force: true }).catch(() => undefined);
      getDb().delete(uploads).where(eq(uploads.id, upload.id)).run();
    }
    return expired.length;
  }
}
