"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

/**
 * DS20 — the "structural and destructive actions" menu (rename, set kind,
 * set carryover, archive, reorder) behind each budget row's `⋯`. Not a
 * shadcn-generated file (this project has no `dropdown-menu` entry in
 * `components.json`'s registry set today), hand-wrapped over
 * `@base-ui/react/menu` following the exact same part-wrapping convention
 * `dialog.tsx` already uses for `@base-ui/react/dialog`.
 */
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "sideOffset" | "align">) {
  return (
    <DropdownMenuPortal>
      <MenuPrimitive.Positioner sideOffset={sideOffset} align={align} className="z-50">
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "min-w-[10rem] origin-[var(--transform-origin)] rounded-lg bg-popover p-1 text-sm text-popover-foreground ring-1 ring-foreground/10 shadow-lift outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </DropdownMenuPortal>
  )
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none",
        "data-highlighted:bg-muted",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        variant === "destructive" && "text-destructive data-highlighted:bg-[color-mix(in_oklch,var(--destructive)_14%,var(--background))]",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Required around `DropdownMenuLabel`: Base UI's `Menu.GroupLabel` reads
 * `MenuGroupContext` and THROWS ("Menu group parts must be used within
 * <Menu.Group> or <Menu.RadioGroup>") without it — which takes the whole
 * route into its error boundary, not just the menu.
 *
 * Missing until the `⋯` row menu on /transactions became the first consumer
 * of `DropdownMenuLabel` at all. `_category-menu.tsx`, this file's only other
 * consumer, uses Trigger/Content/Item/Separator and never a label, so the
 * gap had no way to surface.
 */
function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-3", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-[var(--rule-regular)]", className)}
      {...props}
    />
  )
}

export {
  DropdownMenuGroup,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
