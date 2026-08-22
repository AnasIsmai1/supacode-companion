// Writing text into a live Claude session.
//
// The reason v1 could not send was the zmx binary, not vim — see lib/zmx.ts.
//
// The ESC+A prefix that remains is defensive, not the fix. Claude Code honours
// `editorMode: vim`, and a session sitting in NORMAL would execute plain text as
// vim commands. Verified harmless when already in INSERT: sending ESC+A+"hello"
// appends "hello" with no literal "A". Two bytes against a destructive failure.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zmx } from "./zmx.ts";

const SETTINGS = join(homedir(), ".claude", "settings.json");
const ESC = "\x1b";
const ENTER = "\r";
/** Claude Code enables the Kitty keyboard protocol (it emits \x1b[=1;1u), under
 *  which Enter arrives as CSI-u. Plain \r is the legacy form and is not always
 *  honoured — the symptom is text landing in the input box and simply sitting
 *  there. shift+tab needed the same treatment (\x1b[9;2u, not \x1b[Z). */
const ENTER_CSI_U = "\x1b[13u";

/**
 * Arrow keys, in SS3 form.
 *
 * Claude Code puts the terminal in application cursor mode (DECCKM), so the
 * ordinary CSI arrows (\x1b[A) are ignored outright — verified live: \x1b[B did
 * not move a dialog selection at all, \x1bOB moved it every time. readline and
 * ordinary shells accept SS3 too, so this is safe to use everywhere.
 */
export const ARROW = {
  up: "\x1bOA",
  down: "\x1bOB",
  right: "\x1bOC",
  left: "\x1bOD",
} as const;

let vimCache: { at: number; value: boolean } | null = null;

/** Only prefix when vim mode is actually on, else we'd type a literal "A". */
export function vimMode(): boolean {
  if (vimCache && Date.now() - vimCache.at < 30_000) return vimCache.value;
  let value = false;
  try {
    if (existsSync(SETTINGS)) value = JSON.parse(readFileSync(SETTINGS, "utf8")).editorMode === "vim";
  } catch {
    /* unreadable settings: assume no vim, worst case is one stray char */
  }
  vimCache = { at: Date.now(), value };
  return value;
}

/** The exact bytes we will write. Exposed so the UI can show them and tests can assert. */
export function payload(text: string, submit = true): string {
  const body = vimMode() ? `${ESC}A${text}` : text;
  return submit ? body + ENTER : body;
}

async function write(session: string, data: string): Promise<boolean> {
  return (await zmx(["send", session, data])).ok;
}

/**
 * Is the text still sitting unsent in the prompt box?
 *
 * The prompt box is the region between the last two horizontal rules, just above
 * the statusline. Searching the whole screen does not work: a message that WAS
 * submitted is echoed back into the conversation with the same "❯" prefix, which
 * made an earlier version of this report failure on every successful send.
 */
async function stillInInput(session: string, text: string): Promise<boolean> {
  const { out } = await zmx(["history", session, "--vt"]);
  const lines = out
    .replace(/\x1b\[[0-9;?=]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .split("\n");

  const rules: number[] = [];
  lines.forEach((l, i) => { if (/^[─━]{20,}\s*$/.test(l.trim())) rules.push(i); });
  if (rules.length < 2) return false; // cannot locate the box; do not claim failure

  const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join("\n");
  const probe = text.trim().slice(0, 24);
  return Boolean(probe) && box.includes(probe);
}

/**
 * Type a message and submit it, then check that it actually went.
 *
 * Sending is the one operation where a silent failure is worst: the message
 * looks sent, sits in the laptop's input box, and Claude never sees it. So we
 * verify and retry with the CSI-u Enter before reporting success.
 */
export async function sendText(session: string, text: string): Promise<boolean> {
  if (!(await write(session, payload(text)))) return false;

  await Bun.sleep(350);
  if (!(await stillInInput(session, text))) return true;

  // Legacy CR was ignored — almost certainly the Kitty protocol.
  await write(session, ENTER_CSI_U);
  await Bun.sleep(350);
  if (!(await stillInInput(session, text))) return true;

  // One last try with a bare CR, then admit failure rather than lie.
  await write(session, ENTER);
  await Bun.sleep(300);
  return !(await stillInInput(session, text));
}

/** Answer a numbered prompt. Prompts are modal — they read the key directly, so
 *  no vim prefix, and ESC would dismiss the prompt rather than select anything. */
export const sendChoice = (zmx: string, key: string) => write(zmx, key);

export const sendRawKeys = write;
