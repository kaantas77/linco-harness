export interface DriverSchema {
  name: string;
  required: string[];
  properties: string[];
}

/** Keeps only fields the live tools/list schema declared. A call with a missing required field does not reach the driver. */
export function fitArguments(
  schema: DriverSchema | undefined,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; missing: string[] } {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    present[key] = value;
  }
  if (!schema || schema.properties.length === 0) {
    return { args: present, missing: schema?.required.filter((key) => present[key] === undefined) ?? [] };
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(present)) {
    if (schema.properties.includes(key)) next[key] = value;
  }
  return { args: next, missing: schema.required.filter((key) => next[key] === undefined) };
}

export function parseSchemas(value: unknown): DriverSchema[] {
  if (!Array.isArray(value)) return [];
  const schemas: DriverSchema[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; required?: unknown; properties?: unknown };
    if (typeof record.name !== "string") continue;
    schemas.push({
      name: record.name,
      required: Array.isArray(record.required) ? record.required.filter((entry): entry is string => typeof entry === "string") : [],
      properties: Array.isArray(record.properties) ? record.properties.filter((entry): entry is string => typeof entry === "string") : [],
    });
  }
  return schemas;
}
