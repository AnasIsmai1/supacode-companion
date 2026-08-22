#!/bin/bash
# Claude Code event stream -> ~/.claude/companion/events/<session_id>.jsonl
#
# The dashboard learns what a session is doing by re-reading the transcript and
# by scraping the terminal. Both lag. Hooks fire the moment it happens, and
# UserPromptSubmit is the only reliable way to see a prompt typed on the Mac.
#
# Registered for UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure
# and Stop. Notification stays with notify.sh — this writes to events/, that
# writes to spool/, so the two never touch the same file and never race.
#
# Runs on EVERY tool call and PreToolUse blocks the call, so this is one
# process and nothing else — notify.sh can afford a python3 per field, this
# cannot. Measured on this Mac, best of 3x40 runs:
#
#   bash startup   4ms   irreducible, it is a .sh
#   bun startup   14ms   floor for any real JSON parser
#   this program   3ms
#   the fs calls   6ms
#   total         27ms   (the same script on /usr/bin/python3: 42ms)
#
# So 27ms, not the 20ms asked for. python3 cannot get there — it burns 31ms of
# interpreter startup before reading a byte. Only awk (4ms) can, which is why
# supacode-managed-hook shells out to awk, but its extractor only pulls flat
# top-level strings; this needs tool_input.file_path out of a nested object
# with escaped quotes in it, and a regex that guesses at that is the failure
# mode the schema was verified to avoid. 7ms against a tool call that takes
# 100ms-10s is the cheaper trade.
#
# If 27ms ever does bite, the one-line fix is to background the bun call
# (`... <<< "$payload" >/dev/null 2>&1 &`), which drops the blocking cost to
# ~5ms. Not done here: it puts delivery at the mercy of how Claude Code reaps
# a hook process group, and this exists to be more reliable than the polling
# it replaces, not less.
#
# Never blocks and never fails a tool call — exit 0 is unconditional.
set -uo pipefail

BUN=$(command -v bun || true)
for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -n "$BUN" ] && break
  [ -x "$c" ] && BUN=$c
done
[ -n "$BUN" ] || exit 0

# Field names verified against https://code.claude.com/docs/en/hooks:
#   UserPromptSubmit    prompt
#   PreToolUse          tool_name, tool_input, tool_use_id
#   PostToolUse         + tool_response, duration_ms   (fires on SUCCESS ONLY)
#   PostToolUseFailure  + error, is_interrupt          (failures land here, so
#                                                       a failed tool is only
#                                                       visible if both are
#                                                       registered)
#   Stop                last_assistant_message
# Single-quoted, so the program below must not contain a single quote.
PROG='
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LINE = 4000;          // one append per event, kept small enough to
const MAX_BYTES = 512 * 1024;   // stay atomic against a parallel subagent
const KEEP_LINES = 400;

const cut = (v, n) => (v ? String(v).slice(0, n) : "");

// Tool input reduced to one readable token. Mirrors toolLabel() in
// lib/state.ts so the phone renders hook events and transcript rows alike.
function summarize(ti) {
  if (!ti || typeof ti !== "object") return "";
  const f = ti.file_path ?? ti.path ?? ti.notebook_path;
  if (f) return cut(String(f).replace(/\\\\/g, "/").split("/").pop(), 60);
  for (const k of ["description", "command", "pattern", "url", "query"]) {
    if (ti[k]) return cut(ti[k], 60);
  }
  return "";
}

function build(d) {
  const e = { at: Date.now() };
  switch (d.hook_event_name) {
    case "UserPromptSubmit":
      e.ev = "prompt";
      e.text = cut(d.prompt, 600);
      break;
    case "Stop":
      e.ev = "stop";
      e.text = cut(d.last_assistant_message, 600);
      break;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      e.ev = d.hook_event_name === "PreToolUse" ? "pre" : "post";
      e.tool = cut(d.tool_name, 40);
      const info = summarize(d.tool_input);
      if (info) e.info = info;
      if (d.tool_use_id) e.id = cut(d.tool_use_id, 40);
      if (typeof d.duration_ms === "number") e.ms = Math.round(d.duration_ms);
      if (d.error) e.error = cut(d.error, 300);
      if (d.is_interrupt && !e.error) e.error = "interrupted";
      break;
    }
    default:
      return null;
  }
  if (d.agent_type) e.agent = cut(d.agent_type, 40);
  return e;
}

// Escapes can multiply a capped string, so halve the free-text fields until it
// fits rather than truncating the JSON into something unparseable.
function encode(e) {
  let line = JSON.stringify(e);
  while (line.length > MAX_LINE) {
    const big = ["text", "error", "info"].filter((k) => e[k]);
    if (!big.length) return null;
    for (const k of big) e[k] = e[k].slice(0, Math.floor(e[k].length / 2));
    line = JSON.stringify(e);
  }
  return line;
}

// ponytail: whole-file rewrite, only past MAX_BYTES. A parallel append can
// lose a line here; move to a real log rotator if that ever shows up.
async function rotate(p) {
  let size = 0;
  try { size = statSync(p).size; } catch { return; }
  if (size <= MAX_BYTES) return;
  const text = await Bun.file(p).slice(size - MAX_BYTES / 2).text();
  const keep = text.split("\n").slice(1).filter(Boolean).slice(-KEEP_LINES);
  writeFileSync(p + ".tmp", keep.join("\n") + "\n");
  renameSync(p + ".tmp", p);
}

try {
  const d = JSON.parse(await Bun.stdin.text());
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const sid = String(d.session_id ?? "");
    // The filename comes from the payload: never let it walk the path.
    if (/^[0-9a-fA-F-]{1,64}$/.test(sid)) {
      const e = build(d);
      const line = e && encode(e);
      if (line) {
        const dir = join(homedir(), ".claude", "companion", "events");
        mkdirSync(dir, { recursive: true });
        const p = join(dir, sid + ".jsonl");
        await rotate(p);
        appendFileSync(p, line + "\n");
      }
    }
  }
} catch {}
'

"$BUN" -e "$PROG" 2>/dev/null || true
exit 0
