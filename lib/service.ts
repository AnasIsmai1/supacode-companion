// Is the whole chain up?
//
// launchd only supervises server.ts. It cannot see the three other links that
// have to hold for the phone to show anything: the port, `tailscale serve`'s
// config, and the phone itself being on the tailnet. When one of those is the
// broken one, launchd cheerfully reports "running" — so `sup status` probes all
// four rather than trusting the one that is easiest to ask.
//
// The plist is GENERATED, not committed: it needs the absolute repo path and
// the absolute path to bun in four places, and a committed copy bakes in one
// machine's username.
//
// Self-check: bun lib/service.ts

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.nas.supacode-companion";
export const PORT = Number(Bun.env.PORT ?? 7777);

export const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sh(cmd: string[], timeoutMs = 10_000, cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(killer);
    return { ok: code === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** The launchd job, pointed at this checkout and this bun. */
export function renderPlist(repo = REPO, bun = process.execPath): string {
  const path = [`${homedir()}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xml(bun)}</string>
    <string>run</string>
    <string>${xml(join(repo, "server.ts"))}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xml(repo)}</string>

  <!-- zmx, supacode and git must be on PATH; launchd's default PATH is minimal. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xml(join(repo, "logs", "companion.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(repo, "logs", "companion.err"))}</string>
</dict>
</plist>
`;
}

export type Link = { name: string; ok: boolean; detail: string };

/** Pull `state`, `pid` and `runs` out of `launchctl print`. */
export function parseLaunchctl(out: string): { state: string | null; pid: number | null; runs: number | null } {
  const pick = (k: string) => out.match(new RegExp(`^\\s*${k} = (.+)$`, "m"))?.[1]?.trim() ?? null;
  const pid = pick("pid");
  const runs = pick("runs");
  return { state: pick("state"), pid: pid ? Number(pid) : null, runs: runs ? Number(runs) : null };
}

/** Which tailnet peers can actually reach us — "phone offline" looks identical
 *  to "server down" from the phone, and it is by far the likelier of the two. */
export type Tailnet = {
  /** "Running", "Stopped", "NeedsLogin"… Anything but Running means no phone can reach us. */
  backend: string | null;
  peers: { name: string; os: string; online: boolean }[];
};

export function parseTailnet(json: string): Tailnet {
  try {
    const d = JSON.parse(json) as {
      BackendState?: string;
      Peer?: Record<string, { HostName?: string; OS?: string; Online?: boolean }>;
    };
    return {
      backend: d.BackendState ?? null,
      peers: Object.values(d.Peer ?? {}).map((p) => ({
        name: p.HostName ?? "?",
        os: p.OS ?? "",
        online: Boolean(p.Online),
      })),
    };
  } catch {
    return { backend: null, peers: [] };
  }
}

export async function probe(): Promise<Link[]> {
  const uid = process.getuid?.() ?? 501;
  const links: Link[] = [];

  const lc = await sh(["launchctl", "print", `gui/${uid}/${LABEL}`]);
  const job = parseLaunchctl(lc.out);
  links.push({
    name: "launchd",
    ok: job.state === "running",
    detail: lc.ok
      ? `${job.state ?? "?"}${job.pid ? ` pid ${job.pid}` : ""}${job.runs ? ` · ${job.runs} runs` : ""}`
      : "not loaded — run `sup up`",
  });

  const port = await sh(["lsof", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-n", "-P"]);
  links.push({
    name: `port ${PORT}`,
    ok: port.out.includes("LISTEN"),
    detail: port.out.includes("LISTEN") ? "listening" : "nothing listening",
  });

  let http = "unreachable";
  let httpOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tree`, { signal: AbortSignal.timeout(5000) });
    httpOk = r.ok;
    http = `HTTP ${r.status}`;
    if (r.ok) {
      const d = (await r.json()) as { live?: number };
      http += ` · ${d.live ?? 0} live sessions`;
    }
  } catch {
    /* unreachable */
  }
  links.push({ name: "http", ok: httpOk, detail: http });

  // `tailscale serve --bg` writes tailscaled's ServeConfig; there is no serve
  // PROCESS to look for. Checking for one is how you conclude it is down when
  // it is fine.
  const serve = await sh(["tailscale", "serve", "status", "--json"]);
  const proxied = serve.out.includes(`127.0.0.1:${PORT}`);
  links.push({
    name: "tailscale serve",
    ok: proxied,
    detail: proxied ? `proxying to :${PORT}` : "not configured — run `sup up`",
  });

  // The link launchd cannot see at all. A stopped backend leaves the serve
  // CONFIG in place — it is stored in tailscaled, not in a process — so serve
  // status still looks healthy while nothing can actually reach us. Observed
  // live: launchd/port/http all green, BackendState "Stopped", phone dark.
  const st = await sh(["tailscale", "status", "--json"]);
  const { backend, peers } = parseTailnet(st.out);
  if (backend !== "Running") {
    links.push({
      name: "tailnet",
      ok: false,
      detail: `Tailscale backend is ${backend ?? "unreachable"} — nothing off this Mac can connect`,
    });
  } else {
    const online = peers.filter((p) => p.online);
    const phones = peers.filter((p) => p.os === "android" || p.os === "iOS");
    links.push({
      name: "tailnet",
      ok: phones.length ? phones.some((p) => p.online) : online.length > 0,
      detail: phones.length
        ? phones.map((p) => `${p.name} ${p.online ? "online" : "OFFLINE"}`).join(", ")
        : `${online.length}/${peers.length} peers online`,
    });
  }

  links.push(await checkDashUrl());

  return links;
}

/**
 * The URL notifications tell your phone to open.
 *
 * It lives in ~/.claude/companion/config.env, outside the repo, and nothing ever
 * checked it. It was `http://127.0.0.1:7777` — which on the PHONE means the
 * phone, so every notification tap opened nothing at all, silently, for as long
 * as notifications have existed. A loopback DASH_URL is always wrong; so is a
 * tailnet name that no longer resolves.
 */
export async function checkDashUrl(): Promise<Link> {
  const f = Bun.file(join(homedir(), ".claude", "companion", "config.env"));
  if (!(await f.exists())) return { name: "notify url", ok: false, detail: "no config.env — notifications are off" };

  const url = (await f.text()).match(/^DASH_URL=(.+)$/m)?.[1]?.trim() ?? "";
  if (!url) return { name: "notify url", ok: false, detail: "DASH_URL not set" };
  if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/.test(url)) {
    return { name: "notify url", ok: false, detail: `${url} — loopback resolves to the PHONE, not this Mac` };
  }

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { name: "notify url", ok: r.ok, detail: `${url} -> HTTP ${r.status}` };
  } catch {
    return { name: "notify url", ok: false, detail: `${url} — unreachable` };
  }
}

/** The tail of stderr, which is empty when nothing has gone wrong. */
export async function lastError(repo = REPO): Promise<string> {
  const f = Bun.file(join(repo, "logs", "companion.err"));
  if (!(await f.exists()) || f.size === 0) return "";
  const text = await f.slice(Math.max(0, f.size - 4000)).text();
  return text.trim().split("\n").slice(-5).join("\n");
}

export async function install(repo = REPO): Promise<{ ok: boolean; steps: string[] }> {
  const steps: string[] = [];
  const uid = process.getuid?.() ?? 501;

  const build = await sh(["bun", "run", "build"], 180_000, join(repo, "web"));
  steps.push(build.ok ? "built web/" : "web build FAILED");
  if (!build.ok) return { ok: false, steps };

  await Bun.write(join(repo, "logs", ".keep"), "");
  await Bun.write(plistPath(), renderPlist(repo));
  steps.push(`wrote ${plistPath()}`);

  // `bootout` returns BEFORE launchd has finished unloading, so bootstrapping
  // straight after it fails with the job still half-present — and leaves the
  // service down, which is worse than never having run this. Wait for the job
  // to actually disappear, then retry. Observed: the same bootstrap that failed
  // inside `sup up` succeeded by hand a second later.
  await sh(["launchctl", "bootout", `gui/${uid}/${LABEL}`]);
  for (let i = 0; i < 25; i++) {
    if (!(await sh(["launchctl", "print", `gui/${uid}/${LABEL}`])).ok) break;
    await Bun.sleep(200);
  }

  let boot = { ok: false, out: "" };
  for (let i = 0; i < 5 && !boot.ok; i++) {
    if (i) await Bun.sleep(400);
    boot = await sh(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
  }
  steps.push(boot.ok ? "bootstrapped launchd job" : `launchctl bootstrap FAILED: ${boot.out.trim() || "no output"}`);
  if (!boot.ok) return { ok: false, steps };

  const serve = await sh(["tailscale", "serve", "--bg", String(PORT)], 20_000);
  steps.push(serve.ok ? `tailscale serve -> :${PORT}` : "tailscale serve failed (is Tailscale running?)");

  return { ok: boot.ok, steps };
}

export type Bench = { name: string; ms: number; note: string };

/**
 * Time the hot paths.
 *
 * The perf comments in this repo were wrong by roughly fifty times when they
 * were checked: the code claimed 500ms per zmx spawn and a 4s worktree scan
 * against measured figures under 10ms and 15ms. Caches and TTLs had been tuned
 * against numbers that no longer held. A comment cannot go stale if a command
 * reprints it.
 *
 * Best of three, because the first run of anything pays for a cold cache and
 * the median hides a slow outlier that a phone would feel.
 */
export async function bench(): Promise<Bench[]> {
  const { listSessions } = await import("./sessions.ts");
  const { listWorktrees } = await import("./worktrees.ts");
  const { readChat } = await import("./transcript.ts");
  const { readState } = await import("./state.ts");
  const { tree } = await import("./tree.ts");
  const { zmx } = await import("./zmx.ts");
  const { diffStat, diffSummary } = await import("./diff.ts");
  const { status } = await import("./git.ts");

  const best = async (name: string, note: string, fn: () => Promise<unknown>): Promise<Bench> => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      try { await fn(); } catch { /* a slow failure is still a measurement */ }
      ms = Math.min(ms, performance.now() - t);
    }
    return { name, ms: Math.round(ms), note };
  };

  const out: Bench[] = [];
  // Warm the caches first, so what follows measures steady state rather than
  // one cold scan that nothing in production ever pays twice.
  const sessions = await listSessions(true);
  const worktrees = await listWorktrees(true);

  out.push(await best("listSessions (cached)", `${sessions.length} sessions`, () => listSessions()));
  out.push(await best("listSessions (forced)", "full rescan, ps + zmx ls", () => listSessions(true)));
  out.push(await best("listWorktrees (forced)", `${worktrees.length} worktrees, git per worktree`, () => listWorktrees(true)));
  out.push(await best("tree()", "what the home screen polls every 3s", () => tree()));

  const s = sessions.find((x) => x.zmx);
  if (s) {
    out.push(await best("readChat(200)", "transcript tail", () => readChat(s.sessionId, 200)));
    out.push(await best("readState", "permission mode, usage, queue", () => readState(s.sessionId)));
    out.push(await best("zmx history --vt", "one screen scrape", () => zmx(["history", s.zmx!, "--vt"])));
  }

  const wt = worktrees.find((w) => w.dirty) ?? worktrees[0];
  if (wt) {
    out.push(await best("diffStat", `${wt.path.split("/").pop()}`, () => diffStat(wt.path)));
    out.push(await best("diffSummary", "file list, no patch bodies", () => diffSummary(wt.path)));
    out.push(await best("git status", "porcelain=v2", () => status(wt.path)));
  }
  return out;
}

export async function restart(): Promise<boolean> {
  const uid = process.getuid?.() ?? 501;
  return (await sh(["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`])).ok;
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- plist generation: the point is that nothing is hardcoded ---
  const plist = renderPlist("/tmp/my repo", "/opt/bun");
  assert.ok(plist.includes("<string>/opt/bun</string>"));
  assert.ok(plist.includes("<string>/tmp/my repo/server.ts</string>"), "spaces in the path survive");
  assert.ok(plist.includes("<string>/tmp/my repo/logs/companion.err</string>"));
  // PATH legitimately contains this machine's ~/.bun/bin — the plist is
  // generated per machine. What must NOT leak is a repo path we were not given.
  assert.ok(!plist.includes(REPO), "the developer's checkout must not leak into a generated plist");
  // XML-escaped, or a path with an ampersand produces an unparseable plist.
  assert.ok(renderPlist("/tmp/a&b").includes("/tmp/a&amp;b/server.ts"));

  // --- launchctl parsing ---
  const lc = ["\tstate = running", "\tprogram = /bin/bun", "\truns = 82", "\t\tpid = 34562"].join("\n");
  assert.deepEqual(parseLaunchctl(lc), { state: "running", pid: 34562, runs: 82 });
  assert.deepEqual(parseLaunchctl(""), { state: null, pid: null, runs: null });

  // --- tailnet: the phone being unreachable is the failure we care about ---
  const status = JSON.stringify({
    BackendState: "Running",
    Peer: {
      a: { HostName: "pixel-8-pro", OS: "android", Online: false },
      b: { HostName: "macbook", OS: "macOS", Online: true },
    },
  });
  assert.deepEqual(parseTailnet(status), {
    backend: "Running",
    peers: [
      { name: "pixel-8-pro", os: "android", online: false },
      { name: "macbook", os: "macOS", online: true },
    ],
  });
  // A stopped backend has no Peer key at all — that must not read as "no peers",
  // it is the whole tailnet being down. Seen live on 2026-08-22.
  assert.deepEqual(parseTailnet(JSON.stringify({ BackendState: "Stopped" })), { backend: "Stopped", peers: [] });
  assert.deepEqual(parseTailnet("not json"), { backend: null, peers: [] });

  // --- REPO resolves to this checkout, spaces and all ---
  assert.ok(existsSync(join(REPO, "server.ts")), `REPO should hold server.ts, got ${REPO}`);

  console.log("ok");
}
