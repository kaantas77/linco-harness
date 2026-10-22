import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}
