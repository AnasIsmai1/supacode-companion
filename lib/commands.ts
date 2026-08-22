// Slash commands and skills, indexed once.
//
// This machine has ~1,413 skills, 403 plugin commands and 2 personal commands.
// That is an index to type at, not a list to scroll — and it must not be rebuilt
// per keystroke, so it is cached and only refreshed on demand.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE = join(homedir(), ".claude");

export type Command = { name: string; source: "command" | "skill" | "plugin"; description: string };

/** First `description:` in frontmatter, else the first non-heading line. */
function describe(file: string): string {
  try {
    const head = readFileSync(file, "utf8").slice(0, 1200);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const d = fm[1].match(/^description:\s*(.+)$/m);
      if (d) return d[1].trim().replace(/^["']|["']$/g, "").slice(0, 120);
    }
    const body = fm ? head.slice(fm[0].length) : head;
    const line = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    return (line ?? "").trim().slice(0, 120);
  } catch {
    return "";
  }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

function build(): Command[] {
  const out: Command[] = [];

  for (const f of dirs(join(CLAUDE, "commands"))) {
    if (f.endsWith(".md")) out.push({ name: f.slice(0, -3), source: "command", description: describe(join(CLAUDE, "commands", f)) });
  }

  for (const name of dirs(join(CLAUDE, "skills"))) {
    const skill = join(CLAUDE, "skills", name, "SKILL.md");
    if (existsSync(skill)) out.push({ name, source: "skill", description: describe(skill) });
  }

  // plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md — the version
  // level means a fixed-depth walk misses everything, so glob for it instead.
  try {
    for (const rel of new Bun.Glob("**/commands/*.md").scanSync({ cwd: join(CLAUDE, "plugins"), onlyFiles: true })) {
      const parts = rel.split("/");
      const plugin = parts[parts.length - 4] ?? parts[0];
      const cmd = parts[parts.length - 1].slice(0, -3);
      out.push({
        name: `${plugin}:${cmd}`,
        source: "plugin",
        description: describe(join(CLAUDE, "plugins", rel)),
      });
    }
  } catch {
    /* no plugins installed */
  }

  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.name) && seen.add(c.name)).sort((a, b) => a.name.localeCompare(b.name));
}

let cache: { at: number; value: Command[] } | null = null;
const TTL_MS = 10 * 60_000;

export function commands(force = false): Command[] {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  cache = { at: Date.now(), value: build() };
  return cache.value;
}
