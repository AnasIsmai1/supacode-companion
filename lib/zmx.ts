// Which zmx binary to talk to.
//
// Supacode bundles its own zmx and creates every session with it. A different
// build on $PATH can still `ls` and `history` those sessions, but `send` exits 0
// and silently delivers nothing — that was the real "can't send messages" bug,
// not vim mode. Homebrew ships 0.7.0; Supacode bundles 0.6.0.
//
// Always prefer the bundled binary, since it is by definition the one that
// created the sessions we are writing to.

import { existsSync } from "node:fs";

const BUNDLED = "/Applications/supacode.app/Contents/Resources/zmx/zmx";

export const ZMX = existsSync(BUNDLED) ? BUNDLED : "zmx";

/** Run a zmx subcommand, bounded so a wedged session cannot hang a request. */
export async function zmx(args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn([ZMX, ...args], { stdout: "pipe", stderr: "ignore" });
  const killer = setTimeout(() => p.kill(), timeoutMs);
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  clearTimeout(killer);
  return { ok: code === 0, out };
}
