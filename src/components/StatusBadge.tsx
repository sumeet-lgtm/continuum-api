import { cn } from "@/lib/utils";

export type StatusKind = "valid" | "invalid" | "risky" | "unknown" | "active" | "revoked" | "pending" | "completed" | "failed" | "running" | "error";

const STYLES: Record<string, string> = {
  valid: "bg-[oklch(0.95_0.05_145)] text-[oklch(0.35_0.12_145)] border-[oklch(0.85_0.08_145)]",
  active: "bg-[oklch(0.95_0.05_145)] text-[oklch(0.35_0.12_145)] border-[oklch(0.85_0.08_145)]",
  completed: "bg-[oklch(0.95_0.05_145)] text-[oklch(0.35_0.12_145)] border-[oklch(0.85_0.08_145)]",
  invalid: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.88_0.08_27)]",
  revoked: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.88_0.08_27)]",
  failed: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.88_0.08_27)]",
  error: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.88_0.08_27)]",
  risky: "bg-[oklch(0.97_0.06_75)] text-[oklch(0.42_0.13_60)] border-[oklch(0.88_0.1_75)]",
  pending: "bg-[oklch(0.97_0.06_75)] text-[oklch(0.42_0.13_60)] border-[oklch(0.88_0.1_75)]",
  running: "bg-[oklch(0.97_0.06_75)] text-[oklch(0.42_0.13_60)] border-[oklch(0.88_0.1_75)]",
  unknown: "bg-muted text-muted-foreground border-border",
};

export function StatusBadge({
  status,
  className,
  children,
}: {
  status: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const style = STYLES[status.toLowerCase()] ?? STYLES.unknown;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        style,
        className,
      )}
    >
      {children ?? status}
    </span>
  );
}
