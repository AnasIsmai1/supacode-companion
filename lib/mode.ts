// Claude Code's permission mode.
//
// It is in no state file — the only place it appears is the TUI statusline, and
// the only way to change it is shift+tab, which *cycles*. So: scrape to read,
// press-and-verify to write. Observed live on this machine: "⏵⏵ auto mode on"
// and "bypass permissions on".
//
// If the statusline can't be read we return "unknown" and the UI disables
// switching, rather than pressing blind. See the plan's risk #3.

import { zmx } from "./zmx.ts";
import { sendChoice } from "./send.ts";

export type Mode = "manual" | "accept" | "auto" | "plan" | "bypass" | "unknown";

// Claude Code enables the Kitty keyboard protocol (it emits \x1b[=1;1u), so
// shift+tab arrives as CSI-u, not as classic backtab. Verified live: \x1b[9;2u
// cycles the mode, \x1b[Z does nothing at all.
const SHIFT_TAB = "\x1b[9;2u";
const MAX_PRESSES = 5;
const SETTLE_MS = 450;

// Five distinct statuslines observed live: "manual mode on", "accept edits on",
// "auto mode on", "plan mode on", "bypass permissions on". Conflating any two
// would let a switch stop on the wrong one and report success.
export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "manual", label: "manual", hint: "ask every time" },
  { id: "accept", label: "accept edits", hint: "edits without asking" },
  { id: "auto", label: "auto", hint: "decides for itself" },
  { id: "plan", label: "plan", hint: "no edits at all" },
  { id: "bypass", label: "bypass", hint: "skip all prompts" },
];

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][AB0]/g, "").replace(/\r/g, "");

export function parseMode(screen: string): Mode {
  // Only the last few lines are the statusline; earlier text can mention modes.
  const tail = strip(screen).split("\n").slice(-4).join(" ").toLowerCase();
  if (/bypass(ing)? permissions/.test(tail)) return "bypass";
  if (/plan mode on/.test(tail)) return "plan";
  if (/accept edits on/.test(tail)) return "accept";
  if (/auto mode on/.test(tail)) return "auto";
  if (/manual mode on/.test(tail)) return "manual";
  // The default mode prints no banner, but the hint is always there when we can
  // see the footer at all. No hint means we could not read the statusline.
  if (/shift\+tab to cycle/.test(tail)) return "manual";
  return "unknown";
}

export async function readMode(zmxName: string): Promise<Mode> {
  const { out } = await zmx(["history", zmxName, "--vt"]);
  return parseMode(out);
}

export type SwitchResult = { ok: boolean; mode: Mode; presses: number; error?: string };

/** Cycle with shift+tab until the mode matches, verifying after every press. */
export async function setMode(zmxName: string, target: Mode): Promise<SwitchResult> {
  let mode = await readMode(zmxName);
  if (mode === "unknown") return { ok: false, mode, presses: 0, error: "cannot read the current mode" };
  if (mode === target) return { ok: true, mode, presses: 0 };

  for (let presses = 1; presses <= MAX_PRESSES; presses++) {
    await sendChoice(zmxName, SHIFT_TAB);
    await Bun.sleep(SETTLE_MS);
    mode = await readMode(zmxName);
    if (mode === target) return { ok: true, mode, presses };
  }

  // Never loop forever, and never leave the caller thinking it worked.
  return {
    ok: false,
    mode,
    presses: MAX_PRESSES,
    error: `"${target}" not reachable by cycling; stopped at "${mode}"`,
  };
}
