import { redactBoat } from "../boat/redact.js";

/** Strip provider credentials before a payload leaves the process. */
export function redactSecrets(value: string): string {
  return redactBoat(value).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}
