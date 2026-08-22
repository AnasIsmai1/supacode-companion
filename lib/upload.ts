// Files shared from the phone land in <worktree>/.uploads/.
//
// A filename arriving from a phone is untrusted input at a trust boundary, so
// this module is deliberately paranoid: strip to a basename, whitelist the
// characters, then re-resolve and assert containment. See the plan's risk #3.

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve, join } from "node:path";

export const MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_DIR = ".uploads";

/** Reduce an arbitrary client-supplied name to something safe, or null. */
export function safeName(raw: string): string | null {
  const base = basename(String(raw ?? "").replace(/\\/g, "/"));
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!clean || clean === "_" || clean.length > 120) return null;
  return clean;
}

/** Keep .uploads/ out of git without touching a tracked .gitignore. */
async function excludeLocally(cwd: string) {
  const info = join(cwd, ".git", "info");
  if (!existsSync(info)) return; // not a git worktree, nothing to exclude
  const file = join(info, "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  if (!current.split("\n").includes(`${UPLOAD_DIR}/`)) {
    await appendFile(file, `${current.endsWith("\n") || !current ? "" : "\n"}${UPLOAD_DIR}/\n`);
  }
}

export type Saved = { name: string; rel: string; bytes: number };

export async function saveUpload(cwd: string, file: File): Promise<Saved> {
  if (file.size > MAX_BYTES) throw new Error(`too large (${file.size} > ${MAX_BYTES})`);

  const name = safeName(file.name);
  if (!name) throw new Error("unusable filename");

  const dir = resolve(cwd, UPLOAD_DIR);
  const dest = resolve(dir, name);
  // Belt and braces: even with a sanitised name, prove we stayed inside.
  if (dest !== join(dir, name) || !dest.startsWith(dir + "/")) throw new Error("path escape");

  await mkdir(dir, { recursive: true });
  await Bun.write(dest, file);
  await excludeLocally(cwd);

  return { name, rel: `${UPLOAD_DIR}/${name}`, bytes: file.size };
}
