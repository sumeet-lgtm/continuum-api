export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M 30 0 A 30 30 0 0 0 30 60"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M 30 10 A 20 20 0 0 0 30 50"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.4"
      />
      <path
        d="M 30 0 A 30 30 0 0 1 30 60"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.15"
      />
      <circle cx="30" cy="30" r="4" fill="currentColor" />
      <path
        d="M 6 30 L 14 30 L 18 18 L 22 42 L 26 30 L 34 30 L 38 22 L 42 38 L 46 30 L 54 30"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2 text-foreground">
      <Logo size={size} />
      <span className="text-[15px] font-semibold tracking-tight">Continuum API</span>
    </div>
  );
}
