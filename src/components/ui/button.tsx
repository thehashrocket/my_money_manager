import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Ledger Paper buttons.
 * Variants: default (neutral raised), primary (terracotta), outline, ghost,
 * secondary (muted), destructive (redbrown-tinted), link.
 * Sizes: sm 28px · default 34px · lg 42px — plus icon pairings.
 * Active state presses 1px down (see `active:translate-y-px`).
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap tracking-[0.005em] transition-[background-color,border-color,color,transform] duration-[120ms] outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-card text-foreground border-transparent shadow-[var(--shadow-hair)] hover:bg-muted",
        primary:
          "bg-primary text-primary-foreground border-[color-mix(in_oklch,var(--primary)_65%,black)] hover:bg-[color-mix(in_oklch,var(--primary)_92%,black)]",
        outline:
          "bg-transparent border-border text-foreground hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary)_80%,var(--foreground))]",
        ghost:
          "bg-transparent text-foreground hover:bg-muted",
        destructive:
          "bg-[color-mix(in_oklch,var(--destructive)_14%,var(--background))] text-destructive border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_22%,var(--background))]",
        link:
          "bg-transparent text-primary underline-offset-4 hover:underline px-0",
      },
      size: {
        default: "h-[34px] px-[14px] gap-1.5 text-sm",
        sm: "h-[28px] px-[10px] gap-1 rounded-sm text-xs",
        lg: "h-[42px] px-[18px] gap-1.5 text-base",
        icon: "size-[34px] p-0",
        "icon-sm": "size-[28px] p-0 rounded-sm",
        "icon-lg": "size-[42px] p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
