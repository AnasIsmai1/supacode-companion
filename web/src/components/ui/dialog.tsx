import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

/** Bottom sheet on phones. Radix gives focus trap + escape + scroll lock. */
export function Sheet({
  open, onOpenChange, title, children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <D.Content
          className="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto rounded-t-2xl
                     border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]"
        >
          <div className="sticky top-0 flex items-center justify-between border-b border-line bg-bg px-4 py-3">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            <D.Close className="cursor-pointer rounded-md p-2 text-muted transition-colors duration-200 hover:text-fg" aria-label="Close">
              <X className="size-5" aria-hidden />
            </D.Close>
          </div>
          <div className="px-4 py-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
