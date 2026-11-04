import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "mcsa_token";
export const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function generateAuthToken(secret) {
  const timestamp = Date.now().toString();
  return `${Buffer.from(timestamp).toString("base64url")}.${createHmac("sha256", secret).update(timestamp).digest("hex")}`;
}

export function verifyAuthToken(token, secret) {
  if (typeof token !== "string") return false;
  const [encoded, signature, extra] = token.split(".");
  if (extra !== undefined || !encoded || !/^[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const timestamp = Buffer.from(encoded, "base64url").toString();
  if (!/^\d+$/.test(timestamp)) return false;
  const age = Date.now() - Number(timestamp);
  const expected = createHmac("sha256", secret).update(timestamp).digest();
  return age >= 0 && age <= TOKEN_MAX_AGE_MS && timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export function cookieValue(header, name) {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function hasSession(req, secret) {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const query = new URL(req.url ?? "/", "http://connector.local").searchParams.get("token");
  return [cookieValue(req.headers.cookie, COOKIE_NAME), bearer, query].some((token) => verifyAuthToken(token, secret));
}

export function sameSecret(input, expected) {
  const a = createHmac("sha256", "password-comparison").update(input).digest();
  const b = createHmac("sha256", "password-comparison").update(expected).digest();
  return timingSafeEqual(a, b);
}
