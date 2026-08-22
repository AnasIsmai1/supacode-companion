import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

const MAX_PX = 13;
const MIN_PX = 4; // a 152-col screen on a 390px phone needs ~4.3px to fit whole
// Fira Code advance width is 0.6em; used to predict the rendered width of a line.
const CHAR_RATIO = 0.6;
const LINE_HEIGHT = 1.3;

/**
 * The 16 ANSI colours are names, not values, so they map onto the app's own
 * tokens and the terminal reads as part of the app. 256-colour and 24-bit are
 * literal values the program picked, so those pass through as they arrived.
 */
const BASE = [
  "var(--color-faint)", // black would be invisible on our background
  "var(--color-error)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-accent)", // no cyan token; accent is the nearest thing we have
  "var(--color-fg)",
];
const BRIGHT = ["var(--color-muted)", ...BASE.slice(1, 7), "var(--color-fg)"];

/** Black as a *background* means the terminal's own backdrop, not a grey block. */
const swatch = (i: number, bright: boolean, bg: boolean) =>
  i === 0 && bg && !bright ? "var(--color-bg)" : (bright ? BRIGHT : BASE)[i];

function xterm256(n: number): string {
  if (n < 16) return swatch(n % 8, n >= 8, false);
  if (n < 232) {
    const c = n - 16;
    const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${level(Math.floor(c / 36) % 6)} ${level(Math.floor(c / 6) % 6)} ${level(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g} ${g} ${g})`;
}

type Style = {
  fg?: string; bg?: string;
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; strike?: boolean;
};
type Seg = { text: string; style: Style };

function sgr(prev: Style, params: number[]): Style {
  let s: Style = { ...prev };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) { s.bold = undefined; s.dim = undefined; }
    else if (p === 23) s.italic = undefined;
    else if (p === 24) s.underline = undefined;
    else if (p === 27) s.inverse = undefined;
    else if (p === 29) s.strike = undefined;
    else if (p === 39) s.fg = undefined;
    else if (p === 49) s.bg = undefined;
    else if (p >= 30 && p <= 37) s.fg = swatch(p - 30, false, false);
    else if (p >= 90 && p <= 97) s.fg = swatch(p - 90, true, false);
    else if (p >= 40 && p <= 47) s.bg = swatch(p - 40, false, true);
    else if (p >= 100 && p <= 107) s.bg = swatch(p - 100, true, true);
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) { s[key] = xterm256(params[i + 2] || 0); i += 2; }
      else if (params[i + 1] === 2) { s[key] = `rgb(${params[i + 2] || 0} ${params[i + 3] || 0} ${params[i + 4] || 0})`; i += 4; }
    }
  }
  return s;
}

// Every escape sequence, not just SGR: anything else must be swallowed rather
// than printed as literal text.
const ESC = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|[()][A-Za-z0-9]|.)/g;

const blank = (s: Seg) => !s.style.bg && !s.text.trim();

/** Split the raw screen into styled runs, one array of runs per line. */
export function parse(raw: string): Seg[][] {
  const lines: Seg[][] = [];
  let style: Style = {};

  for (const line of raw.split("\n")) {
    const segs: Seg[] = [];
    let at = 0;
    const push = (text: string) => { if (text) segs.push({ text, style }); };

    ESC.lastIndex = 0;
    for (let m = ESC.exec(line); m; m = ESC.exec(line)) {
      push(line.slice(at, m.index).replace(/\r/g, ""));
      at = m.index + m[0].length;
      if (m[0].endsWith("m")) {
        const body = m[0].slice(2, -1).replace(/:/g, ";");
        style = sgr(style, body === "" ? [0] : body.split(";").map((n) => Number(n) || 0));
      }
    }
    push(line.slice(at).replace(/\r/g, ""));

    // --vt pads every row out to the full terminal width. Uncoloured padding is
    // what makes a 45-col phone think it needs to render 152 columns.
    while (segs.length && blank(segs[segs.length - 1])) segs.pop();
    const last = segs[segs.length - 1];
    if (last && !last.style.bg) last.text = last.text.replace(/\s+$/, "");
    lines.push(segs);
  }

  while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

function css(s: Style): CSSProperties {
  const fg = s.inverse ? (s.bg ?? "var(--color-bg)") : s.fg;
  const bg = s.inverse ? (s.fg ?? "var(--color-fg)") : s.bg;
  const line = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  return {
    color: fg,
    background: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: line || undefined,
  };
}

/**
 * A rendered terminal screen. `zmx history --vt` hands us a flat snapshot of what
 * the TUI currently looks like — colours, no cursor motion — so this replaces the
 * whole view on every read instead of appending, which is the only way `clear`
 * and redraws can ever take effect.
 *
 * Fixed-width art in a narrow viewport either wraps (destroying the layout) or
 * clips (hiding half of it), so the font is scaled to the widest line instead,
 * the same trick AsciiPreview uses for diagrams.
 */
export function Screen({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [size, setSize] = useState(MAX_PX);
  const lines = useMemo(() => parse(text), [text]);
  const cols = useMemo(
    () => Math.max(1, ...lines.map((l) => l.reduce((n, s) => n + s.text.length, 0))),
    [lines],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const available = el.clientWidth - 2; // avoid a sub-pixel wrap on the last column
      if (available <= 0) return;
      setSize(Math.max(MIN_PX, Math.min(MAX_PX, available / (cols * CHAR_RATIO))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols]);

  return (
    <pre
      ref={ref}
      role="region"
      aria-label="Terminal screen"
      tabIndex={0}
      style={{ fontSize: `${size}px`, lineHeight: LINE_HEIGHT }}
      className={cn(
        "m-0 overflow-auto whitespace-pre font-mono text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
        className,
      )}
    >
      {lines.map((segs, i) => (
        <Fragment key={i}>
          {segs.map((s, j) => (
            <span key={j} style={css(s.style)}>{s.text}</span>
          ))}
          {"\n"}
        </Fragment>
      ))}
    </pre>
  );
}
