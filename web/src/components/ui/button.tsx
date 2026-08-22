import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const button = cva(
  // min-h-11 keeps every button at the 44px touch target minimum
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium min-h-11 px-4 " +
    "transition-colors duration-200 cursor-pointer select-none " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg " +
    "disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-accent text-white hover:bg-accent/80",
        outline: "border border-line bg-surface text-fg hover:bg-line",
        ghost: "text-muted hover:text-fg hover:bg-surface",
        danger: "bg-error text-white hover:bg-error/80",
      },
      size: { default: "", sm: "min-h-9 px-3 text-xs", icon: "w-11 px-0" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { asChild?: boolean }
>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(button({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
