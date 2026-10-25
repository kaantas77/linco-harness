import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(storedHash: string, token: string): boolean {
  const actual = Buffer.from(hashToken(token), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
