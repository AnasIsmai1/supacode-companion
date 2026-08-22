import { ChevronLeft, CornerDownLeft, MessageSquare, MoreVertical, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Screen } from "@/components/Screen";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Keys a phone keyboard doesn't have. Labelled, unlike the old number row. */
const KEYS: { label: string; seq: string; wide?: boolean }[] = [
  { label: "esc", seq: "\x1b", wide: true },
  { label: "tab", seq: "\t", wide: true },
  { label: "↑", seq: "\x1bOA" },
  { label: "↓", seq: "\x1bOB" },
  { label: "←", seq: "\x1bOD" },
  { label: "→", seq: "\x1bOC" },
  { label: "^C", seq: "\x03" },
  { label: "^D", seq: "\x04" },
];

const REFRESH_MS = 1000;

/**
 * A TUI is a screen, not a stream. `zmx history --vt` emits colour and nothing
 * else — no cursor motion, no erase — and `zmx tail` only fires when new bytes
 * arrive, so feeding a terminal emulator a snapshot and then appending to it
 * meant `clear` never cleared and redraws piled on top of each other.
 *
 * So: re-read the whole screen on a timer and replace the view. When the shell
 * clears, the next read simply comes back cleared.
 *
 * Output polls; input still goes out over the raw websocket, which is the only
 * path the server exposes to `zmx send`. Its messages are ignored.
 */
export function Terminal({ sessionId, title, onChat, onBack }: {
  sessionId: string; title: string; onChat: (() => void) | null; onBack: () => void;
}) {
  const sock = useRef<WebSocket | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  // The screen is ~17KB and parses into thousands of styled spans. Most polls
  // return an identical screen, so ask the server whether anything moved first:
  // an unchanged reply is 41 bytes and costs no re-render at all.
  const [screen, setScreen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [closing, setClosing] = useState(false);
  const hash = useRef<string | null>(null);

  // Typing felt laggy because a keystroke was only visible after the next poll —
  // up to a full second of echo delay. Sending input now pokes the poller.
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    hash.current = null;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const q = hash.current ? `?since=${encodeURIComponent(hash.current)}` : "";
        const d = await get<{ screen?: string; hash: string; unchanged?: boolean }>(`/api/screen/${sessionId}${q}`);
        if (!alive) return;
        setError(null);
        if (d.unchanged) return;
        hash.current = d.hash;
        setScreen(d.screen ?? "");
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);

    // Coalesced so a burst of keystrokes causes one extra read, not one each.
    let burst: ReturnType<typeof setTimeout> | undefined;
    poke.current = () => {
      clearTimeout(burst);
      burst = setTimeout(tick, 60);
    };

    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(burst);
      poke.current = () => {};
      document.removeEventListener("visibilitychange", tick);
    };
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let backoff = 500;

    const open = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/raw/${sessionId}`);
      sock.current = ws;
      ws.onopen = () => { setConnected(true); setClosed(null); backoff = 500; };
      ws.onclose = (e) => {
        setConnected(false);
        if (disposed) return;
        if (e.code === 1011) { setClosed(e.reason || "no terminal for this window"); return; }
        retry = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => ws.close();
    };
    open();

    // A phone suspends the socket on lock; reconnect as soon as we're visible.
    const wake = () => {
      if (!document.hidden && sock.current?.readyState !== WebSocket.OPEN) {
        clearTimeout(retry);
        backoff = 500;
        open();
      }
    };
    document.addEventListener("visibilitychange", wake);

    return () => {
      disposed = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", wake);
      sock.current?.close();
    };
  }, [sessionId]);

  const send = (seq: string) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(seq);
    poke.current();          // show the echo now, not at the next tick
    input.current?.focus();
  };

  const problem = closed ?? (screen ? null : error);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 flex items-center gap-1 border-b border-line px-2 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to sessions">
          <ChevronLeft className="size-5" aria-hidden />
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-sm">{title}</h1>
        <span className={cn("mr-1 size-2 rounded-full", connected ? "bg-success" : "animate-pulse bg-warning")}
              aria-label={connected ? "Connected" : "Reconnecting"} />
        <Button variant="ghost" size="icon" onClick={() => setMenu(true)} aria-label="Window actions">
          <MoreVertical className="size-5" aria-hidden />
        </Button>
        {onChat && (
          <Button variant="ghost" size="icon" onClick={onChat} aria-label="Back to chat">
            <MessageSquare className="size-5" aria-hidden />
          </Button>
        )}
      </header>

      <Sheet open={menu} onOpenChange={setMenu} title={title}>
        <Button
          variant="danger"
          className="w-full"
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            try {
              // The terminal only knows its surface; the server resolves the tab.
              await post("/api/window/close", { surface: sessionId });
              setMenu(false);
              onBack();
            } catch (e) { setError((e as Error).message); } finally { setClosing(false); }
          }}
        >
          <Trash2 className="size-4" aria-hidden />
          {closing ? "closing…" : "Close this window"}
        </Button>
        <p className="mt-3 text-xs text-muted">
          Exiting the shell here leaves the tab open — this removes it from Supacode.
        </p>
      </Sheet>

      {problem && <p role="alert" className="bg-error/10 px-4 py-2 text-sm text-error">{problem}</p>}

      <Screen text={screen} className="min-h-0 flex-1 px-1 py-1" />

      <footer className="border-t border-line px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {/* Always empty: the keystroke goes straight down the wire and the
            terminal itself echoes it, so there is nothing to hold locally. */}
        <label htmlFor="tty" className="sr-only">Send keystrokes to the terminal</label>
        <input
          ref={input}
          id="tty"
          value=""
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          placeholder="Type into the terminal…"
          onChange={(e) => send(e.target.value)}
          onKeyDown={(e) => {
            const seq = e.key === "Enter" ? "\r" : e.key === "Backspace" ? "\x7f" : null;
            if (!seq) return;
            e.preventDefault();
            send(seq);
          }}
          className="mb-2 w-full rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-[15px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <div className="flex gap-1.5 overflow-x-auto">
          {KEYS.map((k) => (
            <Button
              key={k.label}
              variant="outline"
              size="sm"
              className={cn("shrink-0 font-mono", k.wide ? "min-w-14" : "min-w-11")}
              // Keeps the phone keyboard up: a blur would dismiss it on every key.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => send(k.seq)}
            >
              {k.label}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="min-w-14 shrink-0"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => send("\r")} aria-label="Enter">
            <CornerDownLeft className="size-4" aria-hidden />
          </Button>
        </div>
      </footer>
    </div>
  );
}
