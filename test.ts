// Run: bun test.ts   — asserts only, no framework.
import { strict as assert } from "node:assert";
import { repoOf } from "./lib/worktrees.ts";
import { clean, field } from "./lib/sessions.ts";
import { payload } from "./lib/send.ts";
import { safePath, HOME } from "./lib/fs.ts";
import { ZMX } from "./lib/zmx.ts";
import { parseMode, MODES } from "./lib/mode.ts";
import { commands } from "./lib/commands.ts";
import { parsePermission, parseLiveQuestion } from "./lib/prompts.ts";

const NC = "/Users/NAS/Stuff/Nuclear Codes";
const repos = [`${NC}/ms/sledge/sledge-ai`, `${NC}/ms/drlen528`, `${NC}/ms`, "/Users/NAS/Stuff"]
  .sort((a, b) => b.length - a.length);

// --- repo grouping: a worktree is a SIBLING of its repo, so `/ms` must lose ---
assert.equal(repoOf(`${NC}/ms/sledge/sledge-ai.SLEDGE-1288`, repos), "sledge-ai");
assert.equal(repoOf(`${NC}/ms/sledge/sledge-ai`, repos), "sledge-ai");
assert.equal(repoOf(`${NC}/ms/drlen528`, repos), "drlen528");
assert.equal(repoOf(`${NC}/ms/sledge/sledge-ai/apps/api`, repos), "sledge-ai");
assert.equal(repoOf("/tmp/scratch/foo.branch-x", repos), "foo");
assert.notEqual(repoOf(`${NC}/ms/drlen528`, repos), "Stuff");

// --- parsers ---
assert.equal(clean("a\x1b[1;31mb\x1b[0m"), "ab");
assert.equal(field("name", "  name=supa-abc\tpid=1\tstart_dir=/tmp/foo"), "supa-abc");
assert.equal(field("start_dir", "→ name=x\tpid=1\tstart_dir=/tmp/foo"), "/tmp/foo");
assert.equal(field("nope", "name=x\tpid=1"), null);

// --- the write path ---
// Under vim the prefix must be ESC then A; the trailing CR is what submits.
const p = payload("hello");
assert.ok(p.endsWith("\r"), "must submit");
assert.ok(p.includes("hello"));
assert.ok(!payload("hi", false).endsWith("\r"), "no-submit must not end in CR");
// Supacode's bundled zmx is the only build that can write to its sessions.
assert.ok(ZMX.includes("supacode.app") || ZMX === "zmx", `unexpected zmx: ${ZMX}`);

// --- disk browser containment: untrusted path from a phone ---
for (const bad of ["/etc", "../../", "..", "/", "/Users/NAS/../root", "/var/root"]) {
  assert.throws(() => safePath(bad), `should refuse ${bad}`);
}
assert.equal(safePath(`${HOME}/Documents`), `${HOME}/Documents`);
assert.equal(safePath(null), HOME);

// --- permission box parsing: the one fragile piece ---
// Older Claude Code draws a full box; 2.1.x draws a top rule, a title and a footer.
// Both must parse, and neither shape may be inferred from numbers alone.
const box = [
  "╭────────────────────────────────────╮",
  "│ Do you want to make this edit?     │",
  "│ ❯ 1. Yes                           │",
  "│   2. Yes, allow all edits          │",
  "│   3. No, and tell Claude what to do│",
  "╰────────────────────────────────────╯",
].join("\n");
const boxed = parsePermission(box);
assert.equal(boxed?.kind, "permission");
assert.equal(boxed?.kind === "permission" && boxed.options.length, 3);
assert.equal(boxed?.kind === "permission" && boxed.options[0].label, "Yes");
assert.equal(boxed?.kind === "permission" && boxed.options[2].key, "3");
assert.equal(boxed?.kind === "permission" && boxed.title, "Do you want to make this edit?");

// Claude Code 2.1.x: borderTop only, so there is no box — a rule and a title instead.
const rulePrompt = [
  "  Let me remove the stale build output.",
  "──────────────────────────────────────────────────────────────────",
  " Bash command",
  "   rm -rf build",
  "   Remove the build directory",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for rm commands in /Users/NAS/x",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " esc to cancel",
].join("\n");
const ruled = parsePermission(rulePrompt);
assert.equal(ruled?.kind, "permission");
assert.equal(ruled?.kind === "permission" && ruled.title, "Do you want to proceed?");
assert.equal(ruled?.kind === "permission" && ruled.options.length, 3);

// THE REGRESSION. Prose with a numbered list is not a prompt. This shipped a fake
// approval card to a phone once; five items and no chrome must be silence.
const prose = [
  "⏺ Here is what I would work on next, in order:",
  "",
  "  1. Multi-question tabs",
  "  2. Queueing",
  "  3. Terminal rewrite",
  "  4. Notification batching",
  "  5. Offline cache",
  "",
  "  Tell me which one to start with.",
].join("\n");
assert.equal(parsePermission(prose), null, "prose numbered list is not a permission prompt");

// A markdown rule near the list is still not a prompt: nothing is focused.
assert.equal(parsePermission(["────────────────────────────────────────", "1. one", "2. two"].join("\n")), null);
// And a cursor with no chrome around it is not one either.
assert.equal(parsePermission(["❯ 1. one", "  2. two"].join("\n")), null);

// Real capture, supa-868259df, claude@2.1.234 — the exact shape that misfired.
const realProse = [
  "⏺ Supabase blocker cleared. Note both Anthony and Patrick post from the anthony46032 account, so check the signature.",
  "",
  "  Got it, thanks Patrick. Invite received, I'll get the environments and migrations set up today.",
  "",
  "  Two things to check once you are in:",
  "  1. Your role on the org. You asked for Admin, confirm that is what landed.",
  "  2. Patrick or Anthony still holds Owner, per Section 8.",
  "",
  "  NEXT: With Supabase and GitHub both live, the only outstanding M1 blockers are the Product Specification (A1)",
  "  and your three staffing names. Want me to draft the chase for the spec?",
  "",
  "✻ Churned for 16s",
  "",
  "※ recap: TradePro Edge M1 is underway, day 2 of 7, producing the 12 planning documents due for the $350 milestone.",
  "                                                             new task? /clear to save 207.9k tokens",
  "──────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "──────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Opus 5 | anthony | 207k/1m (20%) | effort: med | 5h 1% @13:00 | claude@2.1.234",
  "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
].join("\n");
assert.equal(parsePermission(realProse), null, "real screen: prose above the input box is not a prompt");

// An empty screen must never produce a prompt.
assert.equal(parsePermission(""), null);
assert.equal(parseLiveQuestion(""), null);

// --- live question: one question, and the multi-question tab row ---
const single = [
  "──────────────────────────────────────────────────────────────",
  " ☐ Palette                                            ✔ Submit",
  " Which colour scheme should the dashboard use?",
  "",
  " ❯ 1. Dark                     ┌────────────────────────────┐",
  "   2. Light                    │ Charcoal with amber accents │",
  "   3. System                   │ Follows the phone at night  │",
  "                               └────────────────────────────┘",
  "                               Notes: press n to add notes",
  "",
  " Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
].join("\n");
const one = parseLiveQuestion(single);
assert.equal(one?.kind, "live-question");
if (one?.kind !== "live-question") throw new Error("unreachable");
assert.equal(one.question, "Which colour scheme should the dashboard use?");
assert.equal(one.options.length, 3);
assert.equal(one.highlighted, "1");
assert.ok(one.preview?.includes("Charcoal"));
assert.equal(one.tabs, undefined, "one question means no tabs");
assert.equal(one.tabCount, undefined);

// Several questions: pills marked ☐/☒, the active one carries a background colour
// and nothing else, so it has to be read before the escapes are stripped.
const BG = "\x1b[48;5;153m\x1b[38;5;16m";
const OFF = "\x1b[39m\x1b[49m";
const multi = [
  "──────────────────────────────────────────────────────────────",
  ` ← ${BG} ☐ Rollout ${OFF}  ☒ Scope   ✔ Submit  →`,
  " How should the migration be rolled out?",
  "",
  " ❯ 1. All at once              ┌────────────────────────────┐",
  "   2. Canary 10%               │ Everything flips on deploy  │",
  "                               └────────────────────────────┘",
  "                               Notes: press n to add notes",
  "",
  " Enter to select · ↑/↓ to navigate · n to add notes · tab to switch questions · Esc to cancel",
].join("\n");
const many = parseLiveQuestion(multi);
if (many?.kind !== "live-question") throw new Error("expected a live question");
assert.deepEqual(many.tabs, ["Rollout", "Scope"]);
assert.equal(many.tabCount, 2);
assert.equal(many.activeTab, 0);
assert.equal(many.question, "How should the migration be rolled out?", "the tab row is not the question");
assert.equal(many.options.length, 2);

// Focus on the Submit tab: no question tab is highlighted, so say so rather than guess.
const onSubmit = parseLiveQuestion(multi.replace(BG, "").replace(OFF, ""));
if (onSubmit?.kind !== "live-question") throw new Error("expected a live question");
assert.equal(onSubmit.activeTab, null);
assert.equal(onSubmit.tabCount, 2);

// --- permission mode: five distinct statuslines, conflating any two would let a
// --- switch stop on the wrong mode and still report success.
assert.equal(parseMode("-- INSERT -- ⏵⏵ accept edits on (shift+tab to cycle)"), "accept");
assert.equal(parseMode("-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)"), "auto");
assert.equal(parseMode("⏸ plan mode on (shift+tab to cycle)"), "plan");
assert.equal(parseMode("manual mode on (shift+tab to cycle)"), "manual");
assert.equal(parseMode("bypass permissions on (shift+tab to cycle)"), "bypass");
assert.equal(parseMode("-- INSERT -- (shift+tab to cycle)"), "manual");
// Unreadable statusline must be "unknown", never a guess.
assert.equal(parseMode("some scrollback with no footer"), "unknown");
assert.equal(new Set(MODES.map((m) => m.id)).size, MODES.length, "mode ids must be unique");

// --- command index: must find real entries and must be cached, not rebuilt ---
const idx = commands();
assert.ok(idx.length > 100, `expected a large index, got ${idx.length}`);
assert.ok(idx.some((c) => c.name === "grilling" && c.source === "skill"));
assert.ok(idx.some((c) => c.source === "plugin" && c.name.includes(":")), "plugin commands live under a version dir");
const t0 = Date.now();
commands();
assert.ok(Date.now() - t0 < 20, "second call must come from cache");

// --- stuckFor: "busy" alone never says where an agent is wedged ---
{
  const { stuckFor, STUCK_MS, STUCK_BLIND_MS } = await import("./lib/sessions.ts");
  const now = 1_800_000_000_000;
  assert.equal(stuckFor("idle", now - 60 * 60_000, 0, now), null, "idle is not stuck, it is done");
  assert.equal(stuckFor("shell", now - 60 * 60_000, 0, now), null);
  assert.equal(stuckFor("busy", now - 1_000, 0, now), null, "a normal tool call is not stuck");
  // No heartbeat: only the turn boundary is known, so the bar is much higher.
  // A 12-minute turn is plausible; claiming it is stuck cries wolf.
  assert.equal(stuckFor("busy", now - 12 * 60_000, 0, now), null, "blind path tolerates a long turn");
  assert.equal(stuckFor("busy", now - STUCK_BLIND_MS, 0, now), STUCK_BLIND_MS, "blind bar");
  assert.equal(stuckFor("busy", now - 37 * 60 * 60_000, 0, now), 37 * 60 * 60_000, "37h is stuck by any measure");

  // With a heartbeat, every tool call is visible, so the bar can be tight.
  assert.equal(stuckFor("busy", 0, now - STUCK_MS + 1, now), null, "just under the line");
  assert.equal(stuckFor("busy", 0, now - STUCK_MS, now), STUCK_MS, "at the line");
  assert.equal(stuckFor("busy", 0, 0, now), null, "no timestamp -> no claim");

  // The heartbeat wins over updatedAt. This is the false positive that showed
  // up live: a healthy session mid-long-turn read as 5 minutes quiet because
  // updatedAt only moves at turn boundaries, while hooks fire per tool call.
  assert.equal(
    stuckFor("busy", now - 30 * 60_000, now - 2_000, now),
    null,
    "tools firing 2s ago -> healthy, whatever updatedAt says",
  );
  assert.equal(
    stuckFor("busy", now - 2_000, now - 30 * 60_000, now),
    30 * 60_000,
    "no tool for 30m -> stuck, even if the turn boundary looks recent",
  );
}

// --- inline option descriptions, from a real captured dialog ---
// Claude Code draws every option's explanation under its title, all at once.
// The parser only understood the other shape (a box to the right holding the
// highlighted option's text), so the phone showed bare titles and you had to
// choose between options you could not read.
{
  const screen = await Bun.file(
    new URL("fixtures/live-question-inline.txt", import.meta.url),
  ).text();
  const p = parseLiveQuestion(screen) as any;
  assert.ok(p && p.kind === "live-question", "the real dialog must parse");
  assert.deepEqual(p.options.map((o: any) => o.key), ["1", "2", "3", "4"]);

  const d = p.descriptions ?? {};
  assert.equal(Object.keys(d).length, 3, "three options carry an explanation");
  assert.ok(d["1"].startsWith("You loaded the chat on the phone"));
  assert.ok(d["2"].startsWith("No trace was captured"));
  assert.ok(d["3"].includes("explanations appeared under each title"));
  // Wrapped lines are rejoined into one readable string, not left as fragments.
  assert.ok(d["1"].length > 120, "continuation lines are joined");
  // "4. Type something." has no explanation and must not get an empty one.
  assert.equal(d["4"], undefined);
  // Nothing below the divider leaks in.
  for (const v of Object.values(d) as string[]) {
    assert.ok(!v.includes("Chat about this"), "the chat row is not a description");
    assert.ok(!v.includes("Enter to select"), "the footer is not a description");
  }
}

console.log("ok");