// Folder browser for "open a project from disk".
//
// The path comes from a phone over an unauthenticated tailnet service, so it is
// untrusted input at a trust boundary: resolve it, then prove it is inside $HOME
// before reading anything. See the plan's risk on containment.

import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, sep } from "node:path";

export const HOME = homedir();
const SKIP = new Set(["node_modules", "Library", ".Trash", "venv", "__pycache__", "dist", "build"]);

export type Entry = { name: string; path: string; git: boolean; registered: boolean };

/** Resolve a client path and refuse anything outside $HOME. */
export function safePath(input: string | null): string {
  // Anchor relative input at $HOME, not the server cwd, so "../.." escapes upward
  // from home and gets refused instead of quietly landing somewhere else in it.
  const target = resolve(HOME, input && input.trim() ? input : ".");
  if (target !== HOME && !target.startsWith(HOME + sep)) throw new Error("outside home directory");
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error("not a directory");
  return target;
}

export function listDir(path: string, registered: Set<string>) {
  const entries: Entry[] = [];
  for (const name of readdirSync(path)) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const full = join(path, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue; // permission denied, broken symlink
    }
    entries.push({
      name,
      path: full,
      git: existsSync(join(full, ".git")),
      registered: registered.has(full),
    });
  }
  entries.sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));

  return {
    path,
    parent: path === HOME ? null : resolve(path, ".."),
    display: path === HOME ? "~" : "~" + path.slice(HOME.length),
    entries,
  };
}
