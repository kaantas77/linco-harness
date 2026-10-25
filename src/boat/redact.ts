/** Strip Boat credentials and desktop URLs before they reach a log, a tool result, or a task error. */
export function redactBoat(value: string): string {
  return value
    .replace(/boat_[A-Za-z0-9_-]+/g, "boat_[redacted]")
    .replace(/https?:\/\/[^\s)]*boat\.dev[^\s)]*/gi, "[boat-url]")
    .replace(/([?&]_token=)[^&\s]+/g, "$1[redacted]");
}
