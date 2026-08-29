export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <style>{`@keyframes cont-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <rect width="32" height="32" rx="8" fill="#000" />
      <g style={{ transformOrigin: "16px 16px", animation: "cont-spin 10s linear infinite" }}>
        <circle cx="16" cy="16" r="9.5" stroke="#fff" strokeWidth="2.8" strokeDasharray="9 3" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2 text-foreground">
      <Logo size={size} />
      <span className="text-[16px] tracking-tight font-display">
        <span className="font-medium">Continuum</span>
        <span className="font-normal italic text-primary"> API</span>
      </span>
    </div>
  );
}
