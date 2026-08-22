import { PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown when the server cannot be reached at all.
 *
 * Previously this state rendered as "Loading…" forever: the poller kept failing,
 * `data` stayed null, and there was nothing to distinguish a slow first load
 * from a dropped Tailscale connection.
 */
export function Disconnected({ detail, onRetry }: { detail?: string | null; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <PlugZap className="size-8 text-warning" aria-hidden />
      <div>
        <p className="text-base font-medium">Can’t reach the Mac</p>
        <p className="mt-1 text-sm text-muted">
          The companion isn’t responding. Check Tailscale is connected on both devices,
          and that the server is running.
        </p>
        {detail && <p className="mt-2 font-mono text-xs text-faint">{detail}</p>}
      </div>
      <Button variant="outline" onClick={() => (onRetry ? onRetry() : location.reload())}>
        <RefreshCw className="size-4" aria-hidden /> Try again
      </Button>
    </div>
  );
}
