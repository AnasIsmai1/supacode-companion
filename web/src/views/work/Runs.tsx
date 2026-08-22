import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Screen } from "@/components/Screen";
import { Button } from "@/components/ui/button";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";

type RunState = {
  session: string;
  exists: boolean;
  running: boolean;
  exitCode: number | null;
  screen: string;
  hash: string;
  unchanged?: boolean;
};

const IDLE_MS = 3000;
const BUSY_MS = 800;

/**
 * Run something in this worktree and watch it.
 *
 * The process belongs to zmx, not to this page: locking the phone, or the
 * companion restarting, does not kill a build. Coming back just re-reads the
 * screen.
 */
export function Runs({ wt }: { wt: string }) {
  const [state, setState] = useState<RunState | null>(null);
  const [presets, setPresets] = useState<{ name: string; command: string }[]>([]);
  const [cmd, setCmd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const hash = useRef<string | null>(null);
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    get<{ scripts: { name: string; command: string }[] }>(`/api/run/scripts?wt=${encodeURIComponent(wt)}`)
      .then((d) => setPresets(d.scripts))
      .catch(() => setPresets([]));
  }, [wt]);

  // Poll fast while something is running, slowly when it is not. The server
  // answers `unchanged` in 40 bytes when the screen has not moved.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!alive) return;
      if (!document.hidden) {
        try {
          const q = hash.current ? `&since=${encodeURIComponent(hash.current)}` : "";
          const d = await get<RunState>(`/api/run?wt=${encodeURIComponent(wt)}${q}`);
          if (!alive) return;
          setError(null);
          hash.current = d.hash;
          setState((prev) => (d.unchanged && prev ? { ...prev, running: d.running, exitCode: d.exitCode } : d));
        } catch (e) {
          if (alive) setError((e as Error).message);
        }
      }
      timer = setTimeout(tick, state?.running ? BUSY_MS : IDLE_MS);
    };

    tick();
    poke.current = () => { clearTimeout(timer); timer = setTimeout(tick, 120); };
    document.addEventListener("visibilitychange", tick);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", tick); };
  }, [wt, state?.running]);

  const run = async (command: string) => {
    if (!command.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      await post(`/api/run?wt=${encodeURIComponent(wt)}`, { command });
      hash.current = null; // force a full read of the new output
      poke.current();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    try { await post(`/api/run/stop?wt=${encodeURIComponent(wt)}`); poke.current(); }
    catch (e) { setError((e as Error).message); }
  };

  const code = state?.exitCode;
  const finished = Boolean(state?.exists) && !state?.running && code !== null && code !== undefined;

  return (
    <div className="flex flex-col">
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          {presets.map((s) => (
            <button
              key={s.name}
              onClick={() => run(s.command)}
              disabled={starting}
              title={s.command}
              className="min-h-9 cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-xs
                         transition-colors duration-200 hover:bg-raised disabled:opacity-50
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-b border-line p-3">
        <label htmlFor="run-cmd" className="sr-only">Command to run</label>
        <input
          id="run-cmd"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(cmd); } }}
          placeholder="a command to run here…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[13px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {state?.running ? (
          <Button variant="danger" size="icon" onClick={stop} aria-label="Stop">
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button size="icon" onClick={() => run(cmd)} disabled={!cmd.trim() || starting} aria-label="Run">
            <Play className="size-4" aria-hidden />
          </Button>
        )}
      </div>

      {error && <p role="alert" className="bg-error/10 px-4 py-2 text-sm text-error">{error}</p>}

      {/* zmx appends ZMX_TASK_COMPLETED:<code> to every run, so pass/fail is
          exact rather than guessed from whatever the tool printed. */}
      {(state?.running || finished) && (
        <p
          role="status"
          className={cn(
            "flex items-center gap-2 border-b border-line px-4 py-2 text-xs",
            state?.running ? "text-muted" : code === 0 ? "bg-success/10 text-success" : "bg-error/10 text-error",
          )}
        >
          {state?.running ? (
            <><span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden /> running…</>
          ) : code === 0 ? (
            "passed"
          ) : (
            `failed — exit ${code}`
          )}
        </p>
      )}

      {state?.exists && state.screen ? (
        <div className="overflow-x-auto p-2">
          <Screen text={state.screen} />
        </div>
      ) : (
        <p className="p-8 text-center text-sm text-muted">
          Nothing has been run here yet.
        </p>
      )}

      {state?.exists && (
        <p className="px-4 pb-4 text-[11px] text-faint">
          Runs in <span className="font-mono">{state.session}</span> — it keeps going if you close this.
        </p>
      )}
    </div>
  );
}
