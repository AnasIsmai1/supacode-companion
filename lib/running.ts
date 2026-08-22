// What a command is printing *right now*.
//
// A tool's output reaches the transcript only when its tool_result block lands,
// which is after the process exits, and the in-flight assistant message is not
// flushed until the turn ends. So mid-command the transcript holds nothing at
// all and a four-minute build is indistinguishable from a hang. The rendered
// screen is the only place those bytes exist while they are being produced.
//
// Self-check: bun lib/running.ts

import { zmx } from "./zmx.ts";

export type Running = {
  lines: string[];
  /** Same value means nothing moved, so a poller can skip the re-render. */
  hash: string;
};

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][AB0]/g, "").replace(/\r/g, "");

// The input box borders: a full-width rule at column zero. The top one can carry
// a label ("────── my-worktree ──"), so only its leading run is fixed. Output can
// draw boxes too, but Claude Code indents everything it prints by at least two
// columns, so a rule flush against column zero is always the box.
const RULE = /^─{8,}/;

// The spinner, while it is spinning: "✻ Catapulting… (4m 18s · esc to interrupt)".
// A word closed by an ellipsis is the only shape that means *now*: "✻ Churned for
// 56s" is the same line once the turn ended, and "⏺ Bash(bun run build…)" is a
// truncated summary, so neither may match. Column zero only, so a tool's own
// "⎿  Running…" stays in the output where it belongs.
const SPINNER = /^[^\w\s]\s+[A-Za-z][^\s(]*…/u;
const INTERRUPT = /esc to interrupt/;

// The mobile-app tip that hangs off the spinner, and its wrapped URL.
const TIP = /^\s*⎿\s+Tip:|^\s{4,}\(https?:\/\//;

// Start of a block. Both tool calls and assistant prose use it, which is exactly
// the boundary wanted: it separates the running tool from the paragraph before it.
const MARKER = /^⏺ /;

// The footer hint above the box ("new task? /clear to save 234.1k tokens",
// "98% context used", "✔ Update installed · Restart to update"). Its right edge
// is not a reliable anchor — after a resize the hint keeps the column it was
// drawn at while the rest of the screen pads to the new width — but its indent
// is: 31 columns at the narrowest observed, against the 2-to-5 that Claude Code
// indents its own output by. Exactly one such line ever appears, so one is all
// this will drop.
const HINT_INDENT = 20;

/**
 * Pull the live command output out of one rendered screen, or null if nothing is
 * running.
 *
 * Everything from the input box's top border down is chrome — prompt, statusline,
 * `-- INSERT --` mode line, background-agent list — so one cut removes all of it,
 * however many lines the user has typed into the box. What sits *above* the box
 * is trimmed by shape instead: spinner, tip, footer hint.
 */
export function parseRunning(screen: string, max = 40): Running | null {
  const lines = strip(screen).split("\n");

  const bottom = lines.findLastIndex((l) => RULE.test(l));
  const top = bottom > 0 ? lines.slice(0, bottom).findLastIndex((l) => RULE.test(l)) : -1;
  if (top < 0) return null; // no input box: not a Claude Code screen

  const near = lines.slice(Math.max(0, top - 10), top);
  if (!near.some((l) => INTERRUPT.test(l) || SPINNER.test(l))) return null;

  const body = lines.slice(0, top);
  let hints = 1;
  while (body.length) {
    const l = body[body.length - 1];
    if (!l.trim() || TIP.test(l) || SPINNER.test(l)) body.pop();
    else if (hints && l.search(/\S/) >= HINT_INDENT) { hints--; body.pop(); }
    else break;
  }

  // Bounded so this can be polled every second or two.
  const win = body.slice(Math.max(0, body.length - max));
  const at = win.findLastIndex((l) => MARKER.test(l));
  const out = (at >= 0 ? win.slice(at) : win).map((l) => l.replace(/\s+$/, ""));
  while (out.length && !out[0]) out.shift();
  if (!out.length) return null;

  return { lines: out, hash: Bun.hash(out.join("\n")).toString(36) };
}

/** The live output of `zmxName`, or null when nothing is running there. */
export async function runningOutput(
  zmxName: string,
  opts: { lines?: number; timeoutMs?: number } = {},
): Promise<Running | null> {
  const { ok, out } = await zmx(["history", zmxName, "--vt"], opts.timeoutMs);
  return ok ? parseRunning(out, opts.lines) : null;
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
  const box = (prompt = "❯ ") =>
    ["─".repeat(80), prompt.padEnd(80), "─".repeat(80),
     "  Opus 5 | repo@main | 58k/1m (5%) | effort: med".padEnd(80),
     "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents".padEnd(80)].join("\n");

  const busy = [
    "⏺ I'll run the suite.",
    "",
    "⏺ Bash(bun test)",
    "  ⎿  Running…",
    "     12 pass",
    "     0 fail",
    "",
    "✻ Catapulting… (4m 18s · ↓ 14.3k tokens · esc to interrupt)",
    "  ⎿  Tip: Control this session from the Claude mobile app",
    "     (https://claude.com/download#mobile) · run /remote-control",
    "                                    ✔ Update installed · Restart to update".padEnd(80),
    box(),
  ].join("\n");

  const r = parseRunning(busy)!;
  assert.deepEqual(r.lines, ["⏺ Bash(bun test)", "  ⎿  Running…", "     12 pass", "     0 fail"]);

  // Idle: same screen, past-tense spinner and no interrupt hint.
  const idle = busy.replace("  ⎿  Running…", "  ⎿  12 pass, 0 fail")
    .replace("✻ Catapulting… (4m 18s · ↓ 14.3k tokens · esc to interrupt)", "✻ Churned for 56s");
  assert.equal(parseRunning(idle), null);

  // A plain shell has no input box, so there is nothing to report.
  assert.equal(parseRunning("~/src ❯ ls\nfoo bar\n~/src ❯ "), null);

  // A multi-line prompt moves the box's top border; the whole box still goes.
  const typed = busy.replace(box(), box("❯ a very long question\n  that wrapped onto two lines"));
  assert.deepEqual(parseRunning(typed)!.lines, r.lines);

  // Change detection: same screen, same hash; one more output line, different hash.
  assert.equal(parseRunning(busy)!.hash, r.hash);
  assert.notEqual(parseRunning(busy.replace("     0 fail", "     0 fail\n     ran in 4s"))!.hash, r.hash);

  console.log("ok");
}
