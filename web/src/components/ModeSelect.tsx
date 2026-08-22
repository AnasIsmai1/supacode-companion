import { useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import { get, post } from "@/lib/api";

type ModeInfo = { id: string; label: string; hint: string };

/** Colour carries risk, text carries meaning — never colour alone. */
const TONE: Record<string, string> = {
  manual: "bg-faint",
  accept: "bg-accent",
  auto: "bg-success",
  plan: "bg-info",
  bypass: "bg-warning",
};

/**
 * Mode is now read from the transcript by the caller and passed in — this used to
 * poll `/api/mode` every 6s at 576ms a call. Only *writing* still needs the TUI:
 * there is no API for it, so the server cycles shift+tab and verifies after each
 * press, giving up after five rather than looping.
 */
export function ModeSelect({
  sessionId, mode, onError,
}: { sessionId: string; mode: string | null; onError: (m: string) => void }) {
  const [modes, setModes] = useState<ModeInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);

  useEffect(() => {
    get<{ modes: ModeInfo[] }>(`/api/mode/${sessionId}`).then((d) => setModes(d.modes)).catch(() => {});
  }, [sessionId]);

  // Drop the optimistic value once the transcript catches up.
  useEffect(() => { if (mode && mode === optimistic) setOptimistic(null); }, [mode, optimistic]);

  const shown = optimistic ?? mode;

  const change = async (target: string) => {
    setBusy(true);
    setOptimistic(target);
    try {
      await post(`/api/mode/${sessionId}`, { target });
    } catch (e) {
      setOptimistic(null);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Unreadable mode: show it, don't offer to press blind.
  if (!shown) return <span className="px-2 text-xs text-faint" title="mode unknown">mode ?</span>;

  return (
    <Select
      label="Permission mode"
      value={shown}
      onValueChange={change}
      placeholder={shown}
      triggerLabel={busy ? "switching…" : shown}
      disabled={busy}
      // Small trigger, wide menu: the header has no room, the menu has plenty.
      className="max-w-[7.5rem]"
      items={modes.map((m) => ({ value: m.id, label: m.label, hint: m.hint, tone: TONE[m.id] ?? "bg-faint" }))}
    />
  );
}
