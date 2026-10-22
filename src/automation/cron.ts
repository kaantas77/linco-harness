const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 8 * * *",
  "@weekly": "0 8 * * 1",
};

/** Next UTC instant strictly after `from` for a five-field cron expression. Day-of-month and month must be `*`. */
export function nextCronRun(expr: string, from: Date): Date {
  const fields = normalizeCron(expr).split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields: ${expr}`);
  const minute = fields[0];
  const hour = fields[1];
  const dayOfMonth = fields[2];
  const month = fields[3];
  const dayOfWeek = fields[4];
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) throw new Error(`invalid cron: ${expr}`);
  if (dayOfMonth !== "*" || month !== "*") {
    throw new Error("cron day-of-month and month must be * in this version");
  }
  const minuteMatch = compileField(minute, 0, 59);
  const hourMatch = compileField(hour, 0, 23);
  const dowMatch = compileField(dayOfWeek, 0, 6);
  const start = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes() + 1,
    0,
    0,
  );
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    const candidate = new Date(start + step * 60_000);
    if (!minuteMatch(candidate.getUTCMinutes())) continue;
    if (!hourMatch(candidate.getUTCHours())) continue;
    if (!dowMatch(candidate.getUTCDay())) continue;
    return candidate;
  }
  throw new Error(`no cron match within a year: ${expr}`);
}

export function normalizeCron(expr: string): string {
  const trimmed = expr.trim();
  return ALIASES[trimmed] ?? trimmed;
}

export function nextScheduleRun(schedule: string, from: Date): Date {
  if (schedule.startsWith("every:")) {
    const everyMs = Number(schedule.slice("every:".length));
    if (!Number.isFinite(everyMs) || everyMs < 1_000) throw new Error("interval must be at least 1000ms");
    return new Date(from.getTime() + everyMs);
  }
  return nextCronRun(schedule, from);
}

export function intervalSchedule(everyMs: number): string {
  if (!Number.isFinite(everyMs) || everyMs < 1_000) throw new Error("interval must be at least 1000ms");
  return `every:${Math.floor(everyMs)}`;
}

function compileField(field: string, min: number, max: number): (value: number) => boolean {
  if (field === "*") return () => true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step?.[1]) {
    const size = Number(step[1]);
    if (!Number.isInteger(size) || size <= 0 || size > max) throw new Error(`bad cron step ${field}`);
    return (value) => value % size === 0;
  }
  if (!/^\d+$/.test(field)) throw new Error(`unsupported cron field ${field}`);
  const exact = Number(field);
  if (exact < min || exact > max) throw new Error(`cron field out of range ${field}`);
  return (value) => value === exact;
}
