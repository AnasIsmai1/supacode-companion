import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type SelectItem = {
  value: string;
  label: string;
  /** Secondary line. Kept out of the label so the trigger stays short. */
  hint?: string;
  /** Optional leading swatch, for states that read faster as colour + text. */
  tone?: string;
};

/**
 * Radix Select — a real listbox with keyboard nav and ARIA, not a native <select>.
 *
 * Label and hint are separate fields rather than one concatenated string: joining
 * them made the trigger wrap to three lines and gave the menu no hierarchy.
 */
export function Select({
  value, onValueChange, placeholder, items, className, triggerLabel, label, disabled,
}: {
  value?: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  items: SelectItem[];
  className?: string;
  triggerLabel?: string;
  /** Accessible name — a placeholder is not a label. */
  label?: string;
  disabled?: boolean;
}) {
  const active = items.find((i) => i.value === value);

  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        aria-label={label}
        className={cn(
          "flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5",
          "text-left text-xs cursor-pointer transition-colors duration-200",
          "hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:opacity-50 disabled:cursor-default",
          className,
        )}
      >
        {active?.tone && <span className={cn("size-1.5 shrink-0 rounded-full", active.tone)} aria-hidden />}
        <span className="min-w-0 flex-1 truncate">
          {triggerLabel ?? active?.label ?? placeholder}
        </span>
        <S.Icon><ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden /></S.Icon>
      </S.Trigger>

      <S.Portal>
        <S.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          // Wide enough for a label plus its hint, capped so it never spans the
          // viewport. Not tied to the trigger width — the trigger is deliberately small.
          className="z-50 max-h-[60vh] w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden
                     rounded-lg border border-line bg-surface shadow-xl"
        >
          {label && (
            <div className="border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-wider text-faint">
              {label}
            </div>
          )}
          <S.Viewport className="p-1">
            {items.map((it) => (
              <S.Item
                key={it.value}
                value={it.value}
                className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-sm
                           data-[highlighted]:bg-raised data-[highlighted]:outline-none
                           data-[state=checked]:bg-raised/60"
              >
                <span className="flex w-4 shrink-0 justify-center pt-0.5">
                  <S.ItemIndicator><Check className="size-3.5 text-accent" aria-hidden /></S.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1">
                  <S.ItemText asChild>
                    <span className="flex items-center gap-2">
                      {it.tone && <span className={cn("size-1.5 shrink-0 rounded-full", it.tone)} aria-hidden />}
                      <span className="truncate font-medium">{it.label}</span>
                    </span>
                  </S.ItemText>
                  {it.hint && <span className="mt-0.5 block text-xs leading-snug text-muted">{it.hint}</span>}
                </span>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
