// Run: bun lib/events.test.ts   — asserts only, no framework, same as test.ts.
//
// Drives the real hooks/events.sh with the payloads Claude Code actually sends
// (field names per https://code.claude.com/docs/en/hooks) and reads them back
// through readEvents(). Writing the fixture by hand would test nothing: the
// point is that the hook and the reader agree on the schema.

import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readEvents, eventsPath, EVENTS_DIR } from "./events.ts";

const SID = "00000000-0000-0000-0000-00000000feed";
// fileURLToPath, not .pathname: this repo lives under "Nuclear Codes" and
// .pathname hands back the %20 still encoded.
const HOOK = fileURLToPath(new URL("../hooks/events.sh", import.meta.url));

async function fire(payload: object) {
  const p = Bun.spawn([HOOK], { stdin: Buffer.from(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe" });
  // A hook that exits non-zero can block the tool call. It never may.
  assert.equal(await p.exited, 0, "hook must always exit 0");
}

rmSync(eventsPath(SID), { force: true });
assert.deepEqual(await readEvents(SID), [], "no file yet -> no events, not a throw");

await fire({ session_id: SID, cwd: "/tmp", hook_event_name: "UserPromptSubmit", prompt: "fix the build" });
await fire({ session_id: SID, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1",
             tool_input: { command: "npm test", description: "Run test suite" } });
await fire({ session_id: SID, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "toolu_2", duration_ms: 12,
             tool_input: { file_path: "/Users/NAS/proj/lib/events.ts" }, tool_response: { success: true } });
await fire({ session_id: SID, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_3", duration_ms: 4187,
             tool_input: { command: "npm test", description: "Run test suite" }, error: "Exit code 1\nCannot find module" });
await fire({ session_id: SID, hook_event_name: "Stop", last_assistant_message: "Done." });

const ev = await readEvents(SID);
assert.equal(ev.length, 5, `expected 5 events, got ${ev.length}`);

assert.equal(ev[0].ev, "prompt");
assert.equal(ev[0].text, "fix the build"); // the whole reason this exists: Mac-typed prompts
assert.ok(ev[0].at > Date.now() - 60_000, "at is ms epoch");

assert.equal(ev[1].ev, "pre");
assert.equal(ev[1].tool, "Bash");
assert.equal(ev[1].info, "Run test suite"); // bash summarises by description, not command
assert.equal(ev[1].id, "toolu_1");

assert.equal(ev[2].ev, "post");
assert.equal(ev[2].info, "events.ts", "file tools summarise to a basename");
assert.equal(ev[2].ms, 12);
assert.equal(ev[2].error, undefined, "a successful PostToolUse carries no error");

// PostToolUse fires on success only; a failed tool arrives as PostToolUseFailure.
// Register only PostToolUse and every failure is invisible.
assert.equal(ev[3].ev, "post");
assert.ok(ev[3].error?.startsWith("Exit code 1"), `expected the failure text, got ${ev[3].error}`);
assert.equal(ev[3].id, "toolu_3", "pairs back to its pre by tool_use_id");

assert.equal(ev[4].ev, "stop");
assert.equal(ev[4].text, "Done.");

// --- limit, ordering, and the guards ---
assert.deepEqual((await readEvents(SID, 2)).map((e) => e.ev), ["post", "stop"], "limit takes the LAST n");
assert.deepEqual([...ev].sort((a, b) => a.at - b.at).map((e) => e.ev), ev.map((e) => e.ev), "oldest first");

await fire({ session_id: SID, hook_event_name: "SessionStart", source: "startup" });
assert.equal((await readEvents(SID)).length, 5, "unhandled events are dropped, not logged");

await fire({ session_id: "../../../../tmp/pwned", hook_event_name: "Stop", last_assistant_message: "x" });
assert.equal(Bun.file("/tmp/pwned.jsonl").size, 0, "session_id must never walk the path");
assert.deepEqual(await readEvents("../../../../tmp/pwned"), [], "reader rejects it too");

// A prompt far over the line cap must still come back as parseable JSON.
await fire({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "x".repeat(50_000) });
const big = (await readEvents(SID)).at(-1)!;
assert.equal(big.ev, "prompt");
assert.ok(big.text!.length > 0 && big.text!.length <= 600, `capped, got ${big.text!.length}`);

rmSync(eventsPath(SID), { force: true });
assert.ok(eventsPath(SID).startsWith(EVENTS_DIR), "path is watchable and under EVENTS_DIR");
console.log("ok");
