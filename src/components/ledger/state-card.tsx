import { cn } from "@/lib/utils";

export type StateCardVariant = "empty" | "loading" | "error" | "success";

const MARK: Record<StateCardVariant, string> = {
  empty: "∅",
  loading: "◐",
  error: "!",
  success: "✓",
};

/** DESIGN.md's "State components" table: shared shell, swap the accent. */
const SURFACE: Record<StateCardVariant, string> = {
  empty: "var(--bg-inset)",
  loading: "var(--bg-inset)",
  error: "color-mix(in oklch, var(--accent-redbrown) 12%, var(--bg))",
  success: "color-mix(in oklch, var(--accent-ledger) 12%, var(--bg))",
};

const MARK_TONE: Record<StateCardVariant, string> = {
  empty: "text-ink-3",
  loading: "text-ink-3",
  error: "text-redbrown",
  success: "text-ledger",
};

/**
 * C5 — the shared `∅`/`◐`/`!`/`✓` shell every PR1b empty and error state
 * renders through (`DESIGN.md`'s "State components" table existed for
 * months with a single inline consumer). One shell, one accent swap per
 * variant — never a bespoke card per page.
 */
export function StateCard({
  variant,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: {
  variant: StateCardVariant;
  title: string;
  description?: React.ReactNode;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg px-6 py-8 text-center shadow-soft",
        className,
      )}
      style={{ background: SURFACE[variant] }}
    >
      <div
        aria-hidden
        className={cn(
          "mb-3 font-mono text-3xl",
          MARK_TONE[variant],
          variant === "loading" && "inline-block animate-spin",
        )}
      >
        {MARK[variant]}
      </div>
      <p className="font-display text-base text-ink-1">{title}</p>
      {description ? <div className="mt-1.5 text-sm text-ink-2">{description}</div> : null}
      {primaryAction || secondaryAction ? (
        <div className="mt-4 flex items-center justify-center gap-3">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
