import { Check, Copy } from "lucide-react";
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Shiki, loaded on demand and deliberately narrow.
 *
 * Importing "shiki" directly pulls its whole grammar registry — that produced
 * 311 chunks and 153MB of build output. `shiki/core` with explicitly imported
 * languages and the JavaScript regex engine (no WASM) keeps it to the handful
 * of languages that actually show up in Claude's output.
 */
const GRAMMARS: Record<string, () => Promise<any>> = {
  ts: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  js: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  python: () => import("@shikijs/langs/python"),
  diff: () => import("@shikijs/langs/diff"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  yaml: () => import("@shikijs/langs/yaml"),
  sql: () => import("@shikijs/langs/sql"),
  md: () => import("@shikijs/langs/markdown"),
};
const ALIAS: Record<string, string> = { typescript: "ts", javascript: "js", sh: "bash", shell: "bash", zsh: "bash", py: "python", yml: "yaml", markdown: "md" };

let corePromise: Promise<any> | null = null;
const loaded = new Set<string>();

async function highlight(code: string, lang: string): Promise<string | null> {
  const key = ALIAS[lang] ?? lang;
  if (!GRAMMARS[key]) return null; // unknown language: stay on the plain fallback

  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/themes/github-dark-default"),
    ]);
    return createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();

  const core = await corePromise;
  if (!loaded.has(key)) {
    await core.loadLanguage((await GRAMMARS[key]()).default);
    loaded.add(key);
  }
  return core.codeToHtml(code, { lang: key, theme: "github-dark-default" });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    highlight(code, lang)
      .then((out) => alive && out && setHtml(out))
      .catch(() => { /* stay on the plain fallback */ });
    return () => { alive = false; };
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked over plain http */ }
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between border-b border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted">{lang || "text"}</span>
        <button
          onClick={copy}
          className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] text-muted
                     transition-colors duration-200 hover:text-fg"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {html
        ? <div className="overflow-x-auto p-3 text-[13px] [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed"><code>{code}</code></pre>}
    </div>
  );
}

/** Claude's output is markdown; v2 rendered it as literal text. */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[15px] leading-relaxed break-words [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold uppercase tracking-wide text-muted first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
          blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>,
          hr: () => <hr className="my-4 border-line" />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">{children}</a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b border-line bg-surface px-3 py-2 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-line/60 px-3 py-2 align-top">{children}</td>,
          code: ({ className, children, ...props }) => {
            const text = String(children).replace(/\n$/, "");
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            // Fenced blocks arrive with a language class; inline code does not.
            if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang ?? ""} />;
            // break-all, not break-words: `overflow-x-hidden` is a single token with
            // no break opportunity in it, and on a phone it is wider than the column.
            return <code className="rounded bg-surface px-1 py-0.5 font-mono text-[13px] break-all text-warning" {...props}>{text}</code>;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
