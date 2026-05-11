import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appConfig } from "../config.js";

const algorithm = "aes-256-gcm";

function getKey() {
  return createHash("sha256").update(appConfig.secretKey).digest();
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string) {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Unsupported encrypted value format");
  }
  const decipher = createDecipheriv(algorithm, getKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function maskSecret(value: string) {
  if (!value) return "未配置";
  if (value.startsWith("sk-")) return "sk-xxxxxxxxxxxxxxxx";
  if (value.length <= 3) return "xxxxxxxx";
  return `${value.slice(0, 3)}xxxxxxxxxxxxxxxx`;
}
