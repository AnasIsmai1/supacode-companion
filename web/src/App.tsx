import { Suspense, lazy, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { post, type Worktree } from "@/lib/api";
import { Tree } from "@/views/Tree";

// Markdown, Shiki and xterm are only needed once you open something — keep them
// out of the tree's first paint.
const Chat = lazy(() => import("@/views/Chat").then((m) => ({ default: m.Chat })));
const Terminal = lazy(() => import("@/views/Terminal").then((m) => ({ default: m.Terminal })));
const Browse = lazy(() => import("@/views/Browse").then((m) => ({ default: m.Browse })));
// The diff renderer is the heaviest thing in the app; it must not be in the
// tree's first paint either.
const Work = lazy(() => import("@/views/Work").then((m) => ({ default: m.Work })));
const Share = lazy(() => import("@/views/Share").then((m) => ({ default: m.Share })));
const Todo = lazy(() => import("@/views/Todo").then((m) => ({ default: m.Todo })));

type Route =
  | { view: "tree" }
  | { view: "chat"; id: string }
  | { view: "term"; id: string; title: string }
  | { view: "work"; wt: string }
  | { view: "share"; id: string }
  | { view: "todo" }
  | { view: "browse" };

function parse(): Route {
  const p = location.pathname;
  let m;
  if ((m = p.match(/^\/s\/([0-9a-f-]{36})$/i))) return { view: "chat", id: m[1] };
  if ((m = p.match(/^\/t\/([0-9a-f-]{36})$/i))) {
    return { view: "term", id: m[1], title: new URLSearchParams(location.search).get("t") ?? "terminal" };
  }
  if (p === "/browse") return { view: "browse" };
  if (p === "/todo") return { view: "todo" };
  // /share-target stashes the files and redirects here. Without this case the
  // redirect fell through to the tree and the stash quietly expired.
  if ((m = p.match(/^\/share\/([0-9a-f-]{36})$/i))) return { view: "share", id: m[1] };
  // Worktree ids are already percent-encoded paths, so they travel as a query
  // param: as a path segment they decode back into slashes and stop matching.
  if (p === "/w") {
    const wt = new URLSearchParams(location.search).get("wt");
    if (wt) return { view: "work", wt };
  }
  return { view: "tree" };
}

const Loading = () => <p className="p-4 text-sm text-muted">Loading…</p>;

export default function App() {
  const [route, setRoute] = useState<Route>(parse);
  const [newWindowFor, setNewWindowFor] = useState<Worktree | null>(null);

  const go = (path: string) => { history.pushState({}, "", path); setRoute(parse()); };
  useEffect(() => {
    const pop = () => setRoute(parse());
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  return (
    // Every view is a flex column that owns its own scrolling main, so the root
    // must NOT scroll too. It did, which nested each view inside a second
    // scroller and let the headers drift off the top on a phone.
    <div className="h-full w-full overflow-hidden">
      <Suspense fallback={<Loading />}>
        {route.view === "chat" && (
          <Chat
            sessionId={route.id}
            onBack={() => go("/")}
            onTerminal={(surfaceId, title) => go(`/t/${surfaceId}?t=${encodeURIComponent(title)}`)}
            onWork={(wt) => go(`/w?wt=${encodeURIComponent(wt)}`)}
          />
        )}
        {route.view === "term" && (
          <Terminal sessionId={route.id} title={route.title} onChat={null} onBack={() => go("/")} />
        )}
        {route.view === "work" && <Work wt={route.wt} onBack={() => go("/")} />}
        {route.view === "share" && (
          <Share id={route.id} onOpen={(sid) => go(`/s/${sid}`)} onBack={() => go("/")} />
        )}
        {route.view === "todo" && <Todo onBack={() => go("/")} />}
        {route.view === "browse" && <Browse onDone={() => go("/")} />}
      </Suspense>

      {route.view === "tree" && (
        <div className="h-full overflow-y-auto overflow-x-hidden">
        <Tree
          onOpen={(w) =>
            w.sessionId
              ? go(`/s/${w.sessionId}`)
              : go(`/t/${w.surfaceId}?t=${encodeURIComponent(w.title)}`)
          }
          onBrowse={() => go("/browse")}
          onTodo={() => go("/todo")}
          onWork={(wt) => go(`/w?wt=${encodeURIComponent(wt.id)}`)}
          onNewWindow={setNewWindowFor}
        />
        </div>
      )}

      <NewWindowSheet wt={newWindowFor} onClose={() => setNewWindowFor(null)} />
    </div>
  );
}

/** Start another window in a worktree — works whether or not it already has one. */
function NewWindowSheet({ wt, onClose }: { wt: Worktree | null; onClose: () => void }) {
  const [what, setWhat] = useState("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!wt) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/window", { worktree: wt.id, input: what });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={Boolean(wt)} onOpenChange={(v) => !v && onClose()} title="New window">
      <p className="mb-4 break-words font-mono text-xs text-muted">{wt?.path}</p>
      <label className="mb-2 block text-xs text-muted">Run</label>
      <Select
        value={what}
        onValueChange={setWhat}
        placeholder="Choose"
        items={[
          { value: "claude", label: "Claude Code" },
          { value: "claude --continue", label: "Claude Code — continue last" },
          { value: "$SHELL", label: "Shell" },
        ]}
      />
      {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
      <Button className="mt-5 w-full" onClick={create} disabled={busy}>
        {busy ? "Starting…" : "Start window"}
      </Button>
    </Sheet>
  );
}
