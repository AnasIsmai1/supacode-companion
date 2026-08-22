// Tracked files in a worktree, for @-completion.

import { existsSync } from "node:fs";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: string[] }>();

async function gitFiles(cwd: string): Promise<string[]> {
  const p = Bun.spawn(["git", "-C", cwd, "ls-files"], { stdout: "pipe", stderr: "ignore" });
  const killer = setTimeout(() => p.kill(), 10_000);
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  clearTimeout(killer);
  return code === 0 ? out.split("\n").filter(Boolean) : [];
}

export async function files(cwd: string, query: string, limit = 30): Promise<string[]> {
  if (!existsSync(cwd)) return [];
  const hit = cache.get(cwd);
  let all = hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
  if (!all) {
    all = await gitFiles(cwd);
    cache.set(cwd, { at: Date.now(), value: all });
  }

  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  // Basename matches first — "@send" should surface lib/send.ts above a folder
  // that merely contains the word.
  const scored = all
    .filter((f) => f.toLowerCase().includes(q))
    .map((f) => ({ f, base: (f.split("/").pop() ?? "").toLowerCase().includes(q) ? 0 : 1 }))
    .sort((a, b) => a.base - b.base || a.f.length - b.f.length);
  return scored.slice(0, limit).map((s) => s.f);
}
