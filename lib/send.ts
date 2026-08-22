// Writing text into a live Claude session.
//
// The reason v1 could not send at all was the zmx binary, not vim — see lib/zmx.ts.
//
// The ESC+A prefix that remains is defensive, not the fix. Claude Code honours
// `editorMode: vim`, and a session sitting in NORMAL would execute plain text as
// vim commands. Verified harmless when already in INSERT: sending ESC+A+"hello"
// appends "hello" with no literal "A". Two bytes against a destructive failure.
//
// Driving an interactive TUI is racy, and the worst outcome is a silent one: the
// message looks sent, sits in the laptop's input box, and Claude never sees it.
// So this is send-confirm-retry, serialized one at a time per session.
//
// Self-check: bun lib/send.ts

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zmx } from "./zmx.ts";
import { parseLiveQuestion, parsePermission } from "./prompts.ts";

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

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?=]*[a-zA-Z]/g, "").replace(/\x1b[()][AB0]/g, "").replace(/\r/g, "");

/**
 * Claude Code's session-rating overlay, if it is up.
 *
 * It floats a single line — "1: Bad   2: Fine   3: Good   0: Dismiss" — just
 * above the composer and captures Enter and number keys. It renders as
 * `N: label` on ONE line, not the `❯ N. label` shape parsePermission matches,
 * so nothing else here can see it. The symptom is text typing into the composer
 * fine and every Enter being swallowed, which reads as "never left the input box
 * after retries". Found by comparison with omg.dev, which hit the same thing.
 */
export function feedbackPromptOpen(screen: string): boolean {
  return strip(screen)
    .split("\n")
    .some((l) => /\b0:\s*Dismiss\b/.test(l) && /\b(Bad|Fine|Good)\b/.test(l));
}

/**
 * The text currently sitting unsent in the prompt box.
 *
 * The box is the region between the last two horizontal rules, just above the
 * statusline. Searching the whole screen does not work: a message that WAS
 * submitted is echoed back into the conversation with the same "❯" prefix, which
 * made an earlier version of this report failure on every successful send.
 *
 * Returns null when the box cannot be located — never guess in that case.
 */
export function inputBoxText(screen: string): string | null {
  const lines = strip(screen).split("\n");
  const rules: number[] = [];
  lines.forEach((l, i) => { if (/^[─━]{20,}\s*$/.test(l.trim())) rules.push(i); });
  if (rules.length < 2) return null;
  return lines
    .slice(rules[rules.length - 2] + 1, rules[rules.length - 1])
    .join("\n");
}

/** The probe we look for. Long enough to be unique, short enough to survive wrapping. */
const probeOf = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 24);

type Box = { text: string | null; screen: string };

async function readBox(session: string): Promise<Box> {
  const { out } = await zmx(["history", session, "--vt"]);
  return { text: inputBoxText(out), screen: out };
}

/** Is our text still sitting unsent in the box? Unknown box => not a failure. */
function holds(box: Box, probe: string): boolean {
  return Boolean(box.text && probe && box.text.replace(/\s+/g, " ").includes(probe));
}

/**
 * Why a send did not land.
 *
 * "zmx send failed" was the only thing the UI could say, for six different
 * causes with six different fixes. A modal dialog being open is not a failure
 * of zmx and telling you it was sends you looking in the wrong place.
 */
export type SendResult = { ok: true } | { ok: false; reason: string };

/**
 * Is a modal dialog on screen?
 *
 * Deliberately the real parsers rather than a keyword match. A regex over the
 * last lines looked fine until the self-check pointed a sentence at it: Claude
 * writes "Would you like…" in ordinary prose all the time, and blocking every
 * send that follows one would be worse than the failure being fixed.
 *
 * parseLiveQuestion and parsePermission already demand the things prose cannot
 * fake — the cursor parked on a numbered option, and Claude's own box chrome
 * immediately above it. They take a screen string, so this costs no extra read.
 */
function modalOpen(screen: string): boolean {
  return Boolean(parseLiveQuestion(screen) ?? parsePermission(screen));
}

/**
 * Type a message and submit it, then prove it actually went.
 *
 * v1 wrote the text and the Enter in a single zmx send, then checked whether the
 * text was still in the box. That cannot tell "sent" from "never typed": both
 * leave an empty box, so a dropped write was reported as success. So confirm the
 * text ARRIVES, then confirm it LEAVES. Two signals, and they disambiguate.
 */
async function deliver(session: string, text: string): Promise<SendResult> {
  const probe = probeOf(text);

  // A rating overlay eats Enter and is invisible to every other parser here.
  const first = await readBox(session);
  if (feedbackPromptOpen(first.screen)) {
    await write(session, "0");
    await Bun.sleep(250);
  }

  // Typing into a session parked on a question goes nowhere, and the Enter that
  // follows selects whatever is highlighted. Refuse rather than press keys into
  // a dialog and report a zmx problem that does not exist.
  if (modalOpen(first.screen)) {
    return { ok: false, reason: "a dialog is open in this session; answer it first" };
  }

  if (!(await write(session, payload(text, false)))) {
    return { ok: false, reason: "zmx would not accept the keystrokes" };
  }
  await Bun.sleep(300);

  let box = await readBox(session);
  if (box.text !== null && !holds(box, probe)) {
    // Nothing of ours arrived. Retype only into an empty box — if there is other
    // text in there it is the user's, and appending to it would corrupt it.
    if (box.text.trim()) {
      return { ok: false, reason: "something else is already typed in the input box" };
    }
    if (!(await write(session, payload(text, false)))) {
      return { ok: false, reason: "zmx would not accept the keystrokes" };
    }
    await Bun.sleep(300);
    box = await readBox(session);
    if (box.text !== null && !holds(box, probe)) {
      return { ok: false, reason: "the text never reached the input box" };
    }
  }

  // CSI-u first: Claude Code turns on the Kitty protocol, so it is the form that
  // is actually honoured. Legacy CR is the fallback, not the other way round.
  for (const key of [ENTER_CSI_U, ENTER, ENTER]) {
    if (!(await write(session, key))) {
      return { ok: false, reason: "zmx would not accept the keystrokes" };
    }
    await Bun.sleep(350);
    if (!holds(await readBox(session), probe)) return { ok: true };
  }
  return { ok: false, reason: "typed, but Enter never submitted it" };
}

/**
 * One delivery at a time per session.
 *
 * deliver() holds a session for up to ~1.5s across its confirm-retry ladder.
 * Two sends overlapping in one input box interleave their characters, and
 * nothing stopped that before — not a phone double-tap (the client guards that),
 * but a second device, or the note that follows an answer.
 */
const chains = new Map<string, Promise<unknown>>();

/** Run something on this session's queue, so nothing interleaves with a send. */
function queue<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(session) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Unbounded growth is not possible: one entry per zmx session, replaced each time.
  chains.set(session, next.catch(() => {}));
  return next;
}

export function sendText(session: string, text: string): Promise<SendResult> {
  return queue(session, () => deliver(session, text));
}

/**
 * Answer a numbered prompt, or move a selection.
 *
 * Prompts are modal — they read the key directly, so no vim prefix, and ESC
 * would dismiss the prompt rather than select anything.
 *
 * On the same queue as sendText. It was not, which left arrow keys and digits
 * free to interleave with a message being typed: the option walk that reads
 * every description presses arrows, and a send landing halfway through it would
 * scatter its characters through a dialog.
 */
export const sendChoice = (zmx: string, key: string) => queue(zmx, () => write(zmx, key));

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  const RULE = "─".repeat(40);
  const screen = (box: string, extra = "") =>
    ["⏺ some earlier turn", "❯ an echoed message from the transcript", RULE, box, RULE,
     "  Opus 5 | repo@main | 58k/1m (5%)", extra].join("\n");

  // --- inputBoxText: only the box, never the transcript echo above it ---
  assert.equal(inputBoxText(screen("❯ hello there")), "❯ hello there");
  assert.equal(inputBoxText(screen("")), "");
  // Fewer than two rules means we cannot locate it — must be null, not "".
  assert.equal(inputBoxText("no rules at all\njust text"), null);

  // The critical one: a submitted message is echoed above with the same prefix.
  // Searching the whole screen would find it and report a false failure.
  const submitted = screen("", "");
  assert.equal(holds({ text: inputBoxText(submitted), screen: submitted }, probeOf("an echoed message")), false);

  const pending = screen("❯ an echoed message from the transcript");
  assert.equal(holds({ text: inputBoxText(pending), screen: pending }, probeOf("an echoed message")), true);

  // --- the rating overlay ---
  assert.equal(feedbackPromptOpen(screen("", "  1: Bad   2: Fine   3: Good   0: Dismiss")), true);
  assert.equal(feedbackPromptOpen(screen("❯ hi")), false);
  // A permission box is numbered too, and must not be mistaken for it.
  assert.equal(feedbackPromptOpen(screen("", "  ❯ 1. Yes\n    2. No")), false);
  // It survives ANSI colouring, which is how it actually arrives.
  assert.equal(feedbackPromptOpen(`\x1b[1m  1: Bad\x1b[0m   2: Fine   3: Good   0: Dismiss`), true);

  // --- the modal guard: this is what "zmx send failed" usually meant ---
  // Typing into a session parked on a question goes nowhere and the Enter picks
  // an option, so it must be refused before any key is pressed.
  const permission = [
    "⏺ I'll update the config.",
    "╭────────────────────────────────╮",
    "│ Do you want to make this edit? │",
    "│ ❯ 1. Yes                       │",
    "│   2. No                        │",
    "╰────────────────────────────────╯",
  ].join("\n");
  assert.equal(modalOpen(permission), true, "a permission box blocks a send");
  assert.equal(modalOpen(screen("❯ half typed")), false, "an ordinary composer does not");

  // The whole reason this is the parsers and not a keyword match: Claude writes
  // these words in prose constantly, and blocking every send after one would be
  // worse than the failure this guards against.
  assert.equal(modalOpen("Would you like me to continue?"), false, "prose is not a dialog");
  assert.equal(modalOpen(screen("", "  Do you want tea? I can put the kettle on.")), false);
  assert.equal(
    modalOpen(screen("", "  1. first thing\n  2. second thing\n  3. third thing")),
    false,
    "a numbered list with no cursor and no chrome is not a dialog",
  );

  // --- probe normalisation: the box wraps and re-spaces what you typed ---
  assert.equal(probeOf("  hello   world  "), "hello world");
  assert.equal(probeOf("x".repeat(50)).length, 24);

  // --- serialization: two sends against one session must not interleave ---
  const order: string[] = [];
  const fake = (id: string) =>
    new Promise<boolean>((res) => {
      order.push(`start:${id}`);
      setTimeout(() => { order.push(`end:${id}`); res(true); }, 30);
    });
  const chain = new Map<string, Promise<unknown>>();
  const serialized = (s: string, id: string) => {
    const prev = chain.get(s) ?? Promise.resolve();
    const next = prev.then(() => fake(id), () => fake(id));
    chain.set(s, next.catch(() => {}));
    return next;
  };
  await Promise.all([serialized("a", "1"), serialized("a", "2")]);
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"], "same session runs in order");

  order.length = 0;
  chain.clear();
  await Promise.all([serialized("a", "1"), serialized("b", "2")]);
  assert.deepEqual(order.slice(0, 2), ["start:1", "start:2"], "different sessions still overlap");

  console.log("ok");
}
