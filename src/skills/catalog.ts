import fs from "node:fs";
import path from "node:path";

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillDocument extends SkillSummary {
  body: string;
}

export class SkillCatalog {
  constructor(private readonly directory: string) {}

  list(): SkillSummary[] {
    if (!fs.existsSync(this.directory)) return [];
    const names = fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const skills: SkillSummary[] = [];
    for (const name of names) {
      const skill = this.load(name);
      if (skill) skills.push({ name: skill.name, description: skill.description });
    }
    return skills;
  }

  load(name: string): SkillDocument | undefined {
    if (!/^[a-z0-9-]+$/.test(name)) return undefined;
    const file = path.join(this.directory, name, "SKILL.md");
    if (!fs.existsSync(file)) return undefined;
    return parseSkill(name, fs.readFileSync(file, "utf8"));
  }
}

export function parseSkill(directoryName: string, source: string): SkillDocument {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  const meta = match?.[1] ? readFrontmatter(match[1]) : {};
  const body = (match?.[2] ?? source).trim();
  const name = meta.name || directoryName;
  const description = meta.description || body.split("\n")[0] || name;
  return { name, description, body };
}

function readFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const split = line.indexOf(":");
    if (split === -1) continue;
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
