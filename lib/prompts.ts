// What a session is waiting on, if anything.
//
// Two kinds, from two different places:
//   AskUserQuestion  — structured, lives in the transcript
//   permission box   — TUI only, never written to the transcript, so it has to be
//                      read off the live screen. This is the fragile part; when
//                      parsing fails we say nothing rather than guess an answer.
//
// The screen parsers are split from the zmx call so a fixture can be fed straight in.

import { readChat, type Question } from "./transcript.ts";
import { zmx } from "./zmx.ts";

export type Pending =
  | { kind: "question"; questions: Question[]; toolUseId: string }
  | {
      kind: "live-question";
      question: string;
      options: { key: string; label: string }[];
      preview: string | null;
      highlighted: string | null;
      // Only when the AskUserQuestion holds more than one question, which Claude
      // Code draws as tabs. Optional so existing callers are unaffected.
      tabs?: string[];
      activeTab?: number | null;
      tabCount?: number;
    }
  | { kind: "permission"; title: string; options: { key: string; label: string }[] }
  | null;

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][AB0]/g, "").replace(/\r/g, "");

/** An AskUserQuestion whose tool_result has not arrived yet. */
export async function pendingQuestion(sessionId: string): Promise<Pending> {
  const turns = await readChat(sessionId, 300);
  const answered = new Set(turns.filter((t) => t.role === "user" && t.toolUseId).map((t) => t.toolUseId));
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.questions && t.toolUseId && !answered.has(t.toolUseId)) {
      return { kind: "question", questions: t.questions, toolUseId: t.toolUseId };
    }
  }
  return null;
}

// "❯ 1. Yes" / "  2. Yes, allow all edits" / "3. No, and tell Claude…"
const OPTION = /^([❯>]?)\s*([1-9])\.\s+(.{2,80}?)\s*$/;
const option = (raw: string) => raw.replace(/[│┃|]/g, " ").trim().match(OPTION);

const TITLE = /^(Do you want|Would you like|Claude wants)/i;
const CORNER = /[╭╮╰╯┌┐└┘]/;
const RULE = /[─━═]{20,}/; // Ink's full-width divider, and the top edge of the prompt

/**
 * A numbered permission box currently on screen.
 *
 * Numbers alone mean nothing: an assistant message ending in a numbered list looks
 * exactly like a prompt, and we shipped a fake approval card to a user because of it.
 * So require the two things prose cannot fake — the ❯ cursor parked on one of the
 * options (it is a select widget; something is always focused), and Claude's own
 * chrome immediately above them: a box edge, a full-width rule, or the "Do you want…"
 * line. Proximity matters. The welcome banner draws a box of its own further up.
 */
/**
 * Strip box-drawing debris from a captured option label.
 *
 * The option list and the preview box share rows, so the column split has to be
 * exact or the box's left border lands on the end of the label — observed in the
 * wild as "Stacked cards │". Column maths cannot be trusted across every render,
 * so scrub the label too: no real option label ends in a box glyph.
 */
function cleanLabel(v: string): string {
  return v
    .replace(/[│┃|┆┇┊┋╎╏┌┐└┘├┤┬┴┼╭╮╰╯─━═╌╍]+\s*$/u, "")
    .replace(/^\s*[│┃|]\s*/u, "")
    .trim();
}

export function parsePermission(screen: string): Pending {
  const lines = strip(screen).split("\n").slice(-40);

  // The LAST run of numbered lines. A numbered list that happens to sit above a real
  // prompt would otherwise donate its items to it. Gaps of up to 3 rows are wrapped
  // labels, not a break.
  const rows: number[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!option(lines[i])) continue;
    if (rows.length && rows[rows.length - 1] - i > 3) break;
    rows.push(i);
  }
  rows.reverse();

  const options: { key: string; label: string }[] = [];
  let cursor = false;
  let sided = false;
  for (const i of rows) {
    const m = option(lines[i])!;
    cursor ||= m[1] !== "";
    sided ||= /[│┃]/.test(lines[i]);
    const label = cleanLabel(m[3]);
    if (label && !options.some((o) => o.key === m[2])) options.push({ key: m[2], label });
  }
  if (options.length < 2 || !cursor) return null;

  const above = lines.slice(Math.max(0, rows[0] - 6), rows[0]).map((l) => l.replace(/[│┃|]/g, " ").trim());
  const title = above.filter((l) => TITLE.test(l)).pop() ?? "";
  if (!sided && !title && !above.some((l) => CORNER.test(l) || RULE.test(l))) return null;

  return { kind: "permission", title: title || "Waiting for your approval", options };
}

export async function pendingPermission(zmxName: string): Promise<Pending> {
  const { out } = await zmx(["history", zmxName, "--vt"]);
  return parsePermission(out);
}

/**
 * True if these ANSI runs set a background colour.
 *
 * Ink marks the active question tab with a background and nothing else — no glyph
 * survives stripping — so the params have to be walked. 40-47 and 100-107 are
 * backgrounds, 48 opens an extended one, and 38's own arguments must be skipped or a
 * foreground colour index of 48 reads as a background.
 */
function hasBackground(s: string): boolean {
  for (const [, params] of s.matchAll(/\x1b\[([\d;]*)m/g)) {
    const p = params.split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 48 || (p[i] >= 40 && p[i] <= 47) || (p[i] >= 100 && p[i] <= 107)) return true;
      if (p[i] === 38) i += p[i + 1] === 5 ? 2 : 4;
    }
  }
  return false;
}

/** The tab row of a multi-question dialog: "← ☐ Scope  ☒ Rollout  ✔ Submit →". */
function parseTabs(raw: string) {
  const cells = raw.split(/(?=[☐☑☒])/);
  if (cells.length < 3) return null; // one checkbox is a single question, not tabs
  const tabs = cells
    .slice(1)
    .map((c) =>
      strip(c)
        .replace(/^[☐☑☒]\s*/, "")
        .replace(/[✔✓√]\s*Submit.*$/, "")
        .replace(/→\s*$/, "")
        .trim(),
    );
  // Null when the Submit tab is focused: no question tab carries the background then.
  const active = cells.slice(1).findIndex((_, i) => hasBackground(cells[i].slice(-64)));
  return { tabs, activeTab: active < 0 ? null : active, tabCount: tabs.length };
}

/**
 * A question that is on screen *right now*.
 *
 * This cannot come from the transcript: a session parked on an AskUserQuestion has
 * zero assistant records written — the in-flight turn is only flushed once the
 * question is answered. Verified on a live dialog. So the live prompt is read off
 * the screen, and the transcript is used only for history and state.
 *
 * Layout: options in a left column, the highlighted option's preview in a box to
 * the right. Everything is split at the column where the box border starts. Several
 * questions in one call are drawn as a tab row above; we report it, nothing more —
 * switching tabs would mean typing into the session.
 */
export function parseLiveQuestion(screen: string): Pending {
  const raws = screen.split("\n");
  const lines = raws.map(strip);

  // Two shapes exist. One has previews and "n to add notes"; the other has no
  // previews and lists "Chat about this" as a numbered option. Both are select
  // dialogs, so key off the one thing they share.
  if (!lines.some((l) => /Enter to select/.test(l) && /to navigate|add notes/.test(l))) return null;

  // The dialog's preview box is the LAST box on screen — the header can contain
  // its own ("What's new"), and splitting every line at that column also truncates
  // the question, which spans the full width above the box.
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes("┌")) { top = i; break; }
  const col = top >= 0 ? lines[top].indexOf("┌") : -1;
  let bottom = lines.length - 1;
  if (top >= 0) for (let i = top + 1; i < lines.length; i++) if (lines[i].includes("└")) { bottom = i; break; }

  // Options sit left of the box; outside the box's rows they occupy the full width.
  const inBox = (i: number) => col > 0 && i >= top && i <= bottom;
  const leftOf = (l: string, i: number) => (inBox(i) ? l.slice(0, col) : l);

  const options: { key: string; label: string }[] = [];
  let highlighted: string | null = null;
  let firstOptionRow = -1;
  lines.forEach((l, i) => {
    const m = leftOf(l, i).match(/^(\s*[❯>]?\s*)([1-9])\.\s+(.+?)\s*$/);
    if (!m) return;
    if (firstOptionRow < 0) firstOptionRow = i;
    if (/[❯>]/.test(m[1])) highlighted = m[2];
    const label = cleanLabel(m[3]);
    if (label && !options.some((o) => o.key === m[2])) options.push({ key: m[2], label });
  });
  if (options.length < 2) return null;

  // Tab row, if any: the lowest checkbox line above the options.
  let tabRow = -1;
  for (let i = firstOptionRow - 1; i >= 0 && i > firstOptionRow - 15; i--) {
    if (/[☐☑☒]/.test(lines[i])) { tabRow = i; break; }
  }
  const tabs = tabRow >= 0 ? parseTabs(raws[tabRow]) : null;

  // The question is the last real sentence above the options, at full width.
  const question =
    lines
      .slice(0, firstOptionRow)
      .map((l, i) => (i === tabRow ? "" : l.trim()))
      .filter((l) => l && !/^[─━│╰╭☐☑☒✔•]/.test(l) && !/^[❯>]/.test(l) && !/^⚠/.test(l) && l.length > 8)
      .pop() ?? "Claude is asking";

  // Preview: only the option box's own rows, borders stripped.
  let preview: string | null = null;
  if (col > 0 && bottom > top) {
    const body = lines
      .slice(top + 1, bottom)
      .map((l) => l.slice(col).replace(/^\s*│/, "").replace(/│\s*$/, "").replace(/\s+$/, ""))
      .filter((l) => l.trim().length);
    if (body.length) preview = body.join("\n");
  }

  // Claude Code shrinks the preview to fit the terminal and marks what it cut
  // with "✂ ─── N lines hidden ───". Those lines are not rendered anywhere on
  // screen, so scraping cannot recover them — report the shortfall rather than
  // showing a one-line box and calling it a preview.
  let previewHidden = 0;
  let shown = preview;
  if (shown) {
    const cut = shown.match(/✂[^0-9]*([0-9]+)\s+lines?\s+hidden/u);
    if (cut) previewHidden = Number(cut[1]);
    shown = shown.split("\n").filter((l) => !l.includes("✂")).join("\n").replace(/\s+$/, "");
    if (!shown.trim()) shown = null;
  }

  // The dialog offers a "Chat about this" row below the options. It is the only
  // way to answer in prose: the dialog is modal, so text typed while it is open
  // goes nowhere. Track whether it exists and whether it currently has focus.
  const chatOption = options.find((o) => /^chat about this$/i.test(o.label));
  const chatRow = lines.find((l) => /(^|\s)Chat about this\s*$/.test(l));
  const canChat = Boolean(chatOption || chatRow);
  const chatFocused = Boolean(chatRow && /[❯>]/.test(chatRow));
  // When it is a numbered option, selecting it is a single keystroke.
  const chatKey = chatOption?.key ?? null;

  const answerable = options.filter((o) => !/^chat about this$/i.test(o.label));
  return { kind: "live-question", question, options: answerable, preview: shown, previewHidden, highlighted, canChat, chatFocused, chatKey, ...tabs };
}

export async function pendingLiveQuestion(zmxName: string): Promise<Pending> {
  const { out } = await zmx(["history", zmxName, "--vt"]);
  return parseLiveQuestion(out);
}

export async function pending(sessionId: string, zmxName: string | null): Promise<Pending> {
  if (!zmxName) return await pendingQuestion(sessionId);
  // Screen first: it is the only place a live question exists.
  return (await pendingLiveQuestion(zmxName)) ?? (await pendingPermission(zmxName)) ?? (await pendingQuestion(sessionId));
}
