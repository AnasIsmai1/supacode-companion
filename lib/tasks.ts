// Claude's own task list for a session.
//
// This is the thing you actually want on a phone: not what tool just ran, but
// what Claude thinks it is working through and how far along it is.
//
// There is no TodoWrite in this version of Claude Code and no todos file on
// disk. The list only exists as a sequence of tool calls in the transcript:
//
//   TaskCreate  {subject, description, activeForm}
//               -> tool_result "Task #7 created successfully: <subject>"
//   TaskUpdate  {taskId: "7", status: "in_progress" | "completed"}
//
// The id is only ever in the RESULT, never in the call, so the two have to be
// paired by tool_use_id before any update can be applied. Rebuilding the list
// means replaying the whole session in order.
//
// Self-check: bun lib/tasks.ts

import { statSync } from "node:fs";
import { transcriptPath } from "./transcript.ts";

export type TaskStatus = "pending" | "in_progress" | "completed";

export type Task = {
  id: string;
  subject: string;
  /** The long form Claude wrote when creating it. Often the real content. */
  description: string;
  /** "Migrating the schema" — present tense, for showing what is happening now. */
  activeForm: string;
  status: TaskStatus;
};

const CREATED = /Task\s+#(\d+)\s+created successfully:\s*(.*)/i;

const asText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c)
    ? c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join(" ")
    : "";

/**
 * Replay TaskCreate and TaskUpdate into the current list.
 *
 * Exported so a fixture can drive it: reading a real transcript is slow and the
 * ordering rules are the part worth testing.
 */
export function replay(records: any[]): Task[] {
  const tasks = new Map<string, Task>();
  // tool_use_id -> the input we saw, waiting for the result that names its id.
  const pendingCreate = new Map<string, { subject: string; description: string; activeForm: string }>();

  for (const d of records) {
    for (const b of (d?.message?.content ?? [])) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "tool_use" && b.name === "TaskCreate" && b.id) {
        const i = b.input ?? {};
        pendingCreate.set(b.id, {
          subject: String(i.subject ?? "").trim(),
          description: String(i.description ?? "").trim(),
          activeForm: String(i.activeForm ?? "").trim(),
        });
        continue;
      }

      if (b.type === "tool_use" && b.name === "TaskUpdate") {
        const id = String(b.input?.taskId ?? "");
        const status = String(b.input?.status ?? "");
        const t = tasks.get(id);
        // An update can arrive for a task created before the window we read.
        if (t && (status === "pending" || status === "in_progress" || status === "completed")) {
          t.status = status;
        }
        continue;
      }

      if (b.type === "tool_result" && b.tool_use_id && pendingCreate.has(b.tool_use_id)) {
        const made = pendingCreate.get(b.tool_use_id)!;
        pendingCreate.delete(b.tool_use_id);
        const m = asText(b.content).match(CREATED);
        if (!m) continue; // the create failed; there is no task to track
        tasks.set(m[1], {
          id: m[1],
          subject: made.subject || m[2].trim(),
          description: made.description,
          activeForm: made.activeForm,
          status: "pending",
        });
      }
    }
  }

  return [...tasks.values()];
}

/** In progress first, then pending, then done. Within a group, creation order. */
export function order(tasks: Task[]): Task[] {
  const rank = { in_progress: 0, pending: 1, completed: 2 } as const;
  return [...tasks].sort(
    (a, b) => rank[a.status] - rank[b.status] || Number(a.id) - Number(b.id),
  );
}

export type TaskList = {
  tasks: Task[];
  counts: { total: number; done: number; active: number };
};

const EMPTY: TaskList = { tasks: [], counts: { total: 0, done: 0, active: 0 } };

/**
 * Cached on the transcript's mtime.
 *
 * Rebuilding means reading the whole file, not a tail: task #1 can be hours of
 * conversation back, and an update to it can be in the last line. One session
 * here has 83 tasks over a multi-megabyte transcript, so this must not run on
 * every 3s poll.
 */
const cache = new Map<string, { mtime: number; value: TaskList }>();

export async function tasksFor(sessionId: string): Promise<TaskList> {
  const path = await transcriptPath(sessionId);
  if (!path) return EMPTY;

  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { return EMPTY; }
  const hit = cache.get(sessionId);
  if (hit && hit.mtime === mtime) return hit.value;

  const text = await Bun.file(path).text();
  const records: any[] = [];
  for (const line of text.split("\n")) {
    // Cheap pre-filter. Parsing every line of a multi-megabyte transcript is the
    // expensive part and only two tool names matter here.
    if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes("created successfully")) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn line */ }
  }

  const tasks = order(replay(records));
  const value: TaskList = {
    tasks,
    counts: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === "completed").length,
      active: tasks.filter((t) => t.status === "in_progress").length,
    },
  };
  cache.set(sessionId, { mtime, value });
  return value;
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  const create = (useId: string, subject: string, extra: Record<string, unknown> = {}) => ({
    message: { content: [{ type: "tool_use", id: useId, name: "TaskCreate", input: { subject, ...extra } }] },
  });
  const result = (useId: string, text: string) => ({
    message: { content: [{ type: "tool_result", tool_use_id: useId, content: text }] },
  });
  const update = (taskId: string, status: string) => ({
    message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId, status } }] },
  });

  // --- the id only exists in the result, so the pairing is the whole job ---
  let t = replay([
    create("u1", "Migrate the schema", { description: "long form", activeForm: "Migrating the schema" }),
    result("u1", "Task #1 created successfully: Migrate the schema"),
  ]);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0], {
    id: "1", subject: "Migrate the schema", description: "long form",
    activeForm: "Migrating the schema", status: "pending",
  });

  // A create with no result yet is not a task. It might still fail.
  assert.deepEqual(replay([create("u1", "half done")]), []);

  // --- updates apply by id, in order ---
  t = replay([
    create("u1", "one"), result("u1", "Task #1 created successfully: one"),
    create("u2", "two"), result("u2", "Task #2 created successfully: two"),
    update("1", "in_progress"),
    update("1", "completed"),
    update("2", "in_progress"),
  ]);
  assert.equal(t.find((x) => x.id === "1")!.status, "completed", "the last update wins");
  assert.equal(t.find((x) => x.id === "2")!.status, "in_progress");

  // An update for a task we never saw created must not invent one.
  t = replay([update("99", "completed")]);
  assert.deepEqual(t, [], "no phantom tasks");

  // A garbage status is ignored rather than stored.
  t = replay([
    create("u1", "one"), result("u1", "Task #1 created successfully: one"),
    update("1", "banana"),
  ]);
  assert.equal(t[0].status, "pending");

  // A failed create leaves nothing behind.
  t = replay([create("u1", "nope"), result("u1", "Error: could not create task")]);
  assert.deepEqual(t, []);

  // tool_result content also arrives as blocks, not only as a string.
  t = replay([
    create("u1", "blocks"),
    { message: { content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "Task #7 created successfully: blocks" }] }] } },
  ]);
  assert.equal(t[0]?.id, "7");

  // --- ordering: what you need to see is what is happening now ---
  const mk = (id: string, status: TaskStatus): Task =>
    ({ id, subject: id, description: "", activeForm: "", status });
  assert.deepEqual(
    order([mk("3", "completed"), mk("1", "pending"), mk("2", "in_progress"), mk("4", "pending")]).map((x) => x.id),
    ["2", "1", "4", "3"],
    "in progress, then pending in creation order, then done",
  );

  // --- against the real transcript that has 83 of them ---
  const { readdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(homedir(), ".claude", "projects");
  let checked = false;
  for (const dir of readdirSync(root)) {
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith(".jsonl") || checked) continue;
      const sid = f.slice(0, -6);
      const list = await tasksFor(sid);
      if (list.counts.total < 10) continue;
      assert.ok(list.tasks.every((x) => x.subject), "every task has a subject");
      assert.ok(list.counts.done <= list.counts.total);
      assert.deepEqual(list.tasks, order(list.tasks), "already ordered");
      // Cached on mtime: the second call must not re-read a multi-MB file.
      const t0 = performance.now();
      await tasksFor(sid);
      assert.ok(performance.now() - t0 < 5, "second call is cached");
      console.log(`  real session: ${list.counts.total} tasks, ${list.counts.done} done, ${list.counts.active} active`);
      checked = true;
    }
  }

  console.log("ok");
}
