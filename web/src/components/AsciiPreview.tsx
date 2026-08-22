import { useLayoutEffect, useRef, useState } from "react";

const MAX_PX = 12;
const MIN_PX = 8;
// Fira Code advance width is 0.6em; used to predict the rendered width of a line.
const CHAR_RATIO = 0.6;

/**
 * ASCII diagrams have a fixed width, so a container narrower than the art either
 * wraps it (destroying the drawing) or scrolls it (hiding half of it). Measured
 * across 93 real previews: widest line is 35 chars median, 65 max. Scaling the
 * font so the longest line fits means every one of them renders whole — at 11px
 * only 87/93 fit, at 9px all 93 do.
 */
export function AsciiPreview({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [size, setSize] = useState(MAX_PX);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      const cols = Math.max(...text.split("\n").map((l) => l.length), 1);
      const available = el.clientWidth - 2; // avoid a sub-pixel wrap on the last column
      if (available <= 0) return;
      setSize(Math.max(MIN_PX, Math.min(MAX_PX, available / (cols * CHAR_RATIO))));
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <pre
      ref={ref}
      style={{ fontSize: `${size}px`, lineHeight: 1.35 }}
      className={className}
    >
      {text}
    </pre>
  );
}
