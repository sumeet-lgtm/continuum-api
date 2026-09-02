import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { CheckCircle2, XCircle, MinusCircle, Search } from "lucide-react";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/dashboard/verify")({
  head: () => ({ meta: [{ title: "Email Verify — Continuum API" }] }),
  component: VerifyPage,
});

interface VerifyResponse {
  email?: string;
  status?: string;
  score?: number;
  checks?: Record<string, boolean | null>;
  [k: string]: unknown;
}

interface VerifRow {
  id: string;
  email: string;
  domain: string;
  status: string;
  subStatus: string | null;
  flags: { disposable: boolean | null; roleAccount: boolean | null; catchAll: boolean | null };
  score: number | null;
  durationMs: number | null;
  checkedAt: string;
}

function ScoreRing({ score, status }: { score: number; status?: string }) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const [animated, setAnimated] = useState(0);
  const prev = useRef(0);

  useEffect(() => {
    prev.current = 0;
    setAnimated(0);
    const start = performance.now();
    const duration = 900;
    const target = score;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      setAnimated(Math.round(ease * target));
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [score]);

  const fill = circ * (animated / 100);
  const strokeColor =
    status === "valid" ? "oklch(0.55 0.16 145)" :
    status === "risky" ? "oklch(0.65 0.16 75)" :
    status === "invalid" ? "oklch(0.58 0.22 27)" :
    "oklch(0.145 0 0)";

  return (
    <svg width={108} height={108} viewBox="0 0 108 108" className="shrink-0">
      <circle cx={54} cy={54} r={r} fill="none" stroke="var(--muted)" strokeWidth={8} />
      <circle
        cx={54} cy={54} r={r} fill="none"
        stroke={strokeColor} strokeWidth={8}
        strokeDasharray={`${fill} ${circ - fill}`}
        strokeLinecap="round"
        transform="rotate(-90 54 54)"
        style={{ transition: "stroke-dasharray 0.05s linear" }}
      />
      <text
        x={54} y={48} textAnchor="middle" dominantBaseline="middle"
        style={{ fill: strokeColor, fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)" }}
      >
        {animated}
      </text>
      <text
        x={54} y={66} textAnchor="middle" dominantBaseline="middle"
        style={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" }}
      >
        / 100
      </text>
    </svg>
  );
}

function VerifyPage() {
  const { apiKey } = useApiKey();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Verification history (API-backed)
  const [verifRows, setVerifRows] = useState<VerifRow[]>([]);
  const [verifTotal, setVerifTotal] = useState(0);
  const [verifPage, setVerifPage] = useState(1);
  const [verifLoading, setVerifLoading] = useState(false);
  const [verifStatus, setVerifStatus] = useState("");
  const [verifQ, setVerifQ] = useState("");
  const [verifQInput, setVerifQInput] = useState("");

  const loadVerifs = useCallback(async (page: number, status: string, q: string) => {
    if (!apiKey?.keyRaw) return;
    setVerifLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) params.set("status", status);
      if (q) params.set("q", q);
      const res = await fetch(`${API_BASE}/v1/verifications?${params}`, {
        headers: { "X-API-Key": apiKey.keyRaw },
      });
      if (!res.ok) return;
      const data = await res.json() as { data: VerifRow[]; pagination: { total: number } };
      setVerifRows(data.data ?? []);
      setVerifTotal(data.pagination?.total ?? 0);
    } catch { /* non-fatal */ } finally {
      setVerifLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void loadVerifs(verifPage, verifStatus, verifQ);
  }, [apiKey, verifPage, verifStatus, verifQ, loadVerifs]);

  // Note: full key not available client-side after creation. We send the prefix —
  // adjust if your gateway expects the full key. UX still demonstrates the flow.
  const onVerify = async () => {
    if (!email || !apiKey?.keyRaw) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/v1/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.keyRaw}`,
          "x-api-key": apiKey.keyRaw,
        },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as VerifyResponse;
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
      } else {
        setResult(data);
        // Reload history to show new result (slight delay for DB write)
        setTimeout(() => void loadVerifs(1, verifStatus, verifQ), 500);
        setVerifPage(1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const checks = (result?.checks ?? {}) as Record<string, boolean | null | undefined>;
  const blacklists = (result as Record<string, unknown> | null)?.blacklists as string[] | undefined;

  type CheckDef = { key: string; label: string; badIfTrue?: boolean; warnIfTrue?: boolean };
  const EMAIL_CHECKS: CheckDef[] = [
    { key: "syntaxValid", label: "Syntax valid" },
    { key: "mxFound", label: "MX record found" },
    { key: "isDisposable", label: "Disposable domain", badIfTrue: true },
    { key: "isRoleAccount", label: "Role account", warnIfTrue: true },
    { key: "smtpChecked", label: "SMTP checked" },
    { key: "smtpReachable", label: "Mailbox reachable" },
    { key: "isCatchAll", label: "Catch-all domain" },
    { key: "greylisted", label: "Greylisted" },
    { key: "freeEmail", label: "Free email provider", warnIfTrue: true },
  ];
  const DOMAIN_CHECKS: CheckDef[] = [
    { key: "spfValid", label: "SPF record valid" },
    { key: "dmarcValid", label: "DMARC policy found" },
    { key: "dkimFound", label: "DKIM configured" },
    { key: "blacklisted", label: "Domain blacklisted", badIfTrue: true },
    { key: "isLookalike", label: "Look-alike / typosquat domain", badIfTrue: true },
  ];

  const renderCheck = (def: CheckDef) => {
    const v = checks[def.key];
    let icon: React.ReactNode;
    let textClass = "";
    if (v === true) {
      if (def.badIfTrue) {
        icon = <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)]" />;
        textClass = "text-[oklch(0.42_0.18_27)]";
      } else if (def.warnIfTrue) {
        icon = <MinusCircle className="h-4 w-4 text-[oklch(0.65_0.16_75)]" />;
        textClass = "text-[oklch(0.42_0.13_60)]";
      } else {
        icon = <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)]" />;
      }
    } else if (v === false) {
      if (def.badIfTrue || def.warnIfTrue) {
        icon = <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)]" />;
      } else {
        icon = <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)]" />;
      }
    } else {
      icon = <MinusCircle className="h-4 w-4 text-muted-foreground" />;
    }
    return (
      <li key={def.key} className={`flex items-center gap-2 text-sm ${textClass}`}>
        {icon}
        <span>{def.label}</span>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Verify</h1>
        <p className="text-sm text-muted-foreground">Run a single email through the API.</p>
      </header>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onVerify()}
          />
          <Button onClick={onVerify} disabled={loading || !email || !apiKey}>
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </div>
        {!apiKey && <p className="mt-2 text-xs text-muted-foreground">No API key configured yet.</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            {/* Score ring header */}
            <div className="flex items-center gap-5 mb-5 pb-5 border-b border-border">
              <ScoreRing score={result.score ?? 0} status={result.status} />
              <div>
                <StatusBadge status={result.status ?? "unknown"} className="mb-2" />
                <p className="text-base font-mono font-medium leading-tight">{result.email as string}</p>
                {Boolean((result as Record<string, unknown>).domain) && (
                  <p className="text-xs text-muted-foreground mt-1">{String((result as Record<string, unknown>).domain)}</p>
                )}
                {Boolean((result as Record<string, unknown>).subStatus) && (
                  <p className="text-xs text-muted-foreground mt-1 font-mono">{String((result as Record<string, unknown>).subStatus)}</p>
                )}
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-2">Email Checks</h3>
                <ul className="space-y-1.5">
                  {EMAIL_CHECKS.map(renderCheck)}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-2">Domain Health</h3>
                <ul className="space-y-1.5">
                  {DOMAIN_CHECKS.map(renderCheck)}
                  {checks.blacklisted === true && blacklists && blacklists.length > 0 && (
                    <li className="ml-6 text-xs text-[oklch(0.42_0.18_27)]">
                      Listed on: {blacklists.join(", ")}
                    </li>
                  )}
                  {checks.isLookalike === true && (checks as Record<string, unknown>).impersonates != null && (
                    <li className="ml-6 text-xs text-[oklch(0.42_0.18_27)]">
                      Impersonates: {String((checks as Record<string, unknown>).impersonates)}
                    </li>
                  )}
                  {(checks as Record<string, unknown>).didYouMean != null && (
                    <li className="ml-6 text-xs text-muted-foreground">
                      Did you mean: {String((checks as Record<string, unknown>).didYouMean)}?
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium mb-3">Raw response</h2>
            <pre className="rounded-md bg-muted p-3 overflow-auto text-xs font-mono max-h-96">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {result && checks.smtpChecked === false && (
        <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">Note:</strong> SMTP could not be confirmed for this address (mailbox server unreachable, timed out, or greylisted). Status reflects syntax, MX, and domain-health signals only — do not treat &quot;unknown&quot; as safe to send without a retry.
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-medium">Verification History</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="h-7 text-xs pl-7 w-48"
                placeholder="Search email…"
                value={verifQInput}
                onChange={(e) => setVerifQInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { setVerifQ(verifQInput); setVerifPage(1); } }}
              />
            </div>
            <select
              className="h-7 text-xs rounded-md border border-input bg-background px-2"
              value={verifStatus}
              onChange={(e) => { setVerifStatus(e.target.value); setVerifPage(1); }}
            >
              <option value="">All</option>
              <option value="valid">Valid</option>
              <option value="invalid">Invalid</option>
              <option value="risky">Risky</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
        </div>

        {verifLoading ? (
          <div className="divide-y divide-border">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-3 w-48 font-mono" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-3 w-8 ml-auto" />
              </div>
            ))}
          </div>
        ) : verifRows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No verifications yet.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                    <th className="px-5 py-2 font-medium">Email</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                    <th className="px-5 py-2 font-medium">Score</th>
                    <th className="px-5 py-2 font-medium">Flags</th>
                    <th className="px-5 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {verifRows.map((v) => (
                    <tr key={v.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-2.5 font-mono text-xs truncate max-w-[220px]">{v.email}</td>
                      <td className="px-5 py-2.5"><StatusBadge status={v.status} /></td>
                      <td className="px-5 py-2.5 tabular-nums text-xs">{v.score ?? "—"}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex gap-1 flex-wrap">
                          {v.flags.disposable && <span className="text-[10px] rounded-full bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] px-1.5 py-0.5 border border-[oklch(0.85_0.12_27)]">disposable</span>}
                          {v.flags.roleAccount && <span className="text-[10px] rounded-full bg-muted text-muted-foreground px-1.5 py-0.5 border border-border">role</span>}
                          {v.flags.catchAll && <span className="text-[10px] rounded-full bg-muted text-muted-foreground px-1.5 py-0.5 border border-border">catch-all</span>}
                        </div>
                      </td>
                      <td className="px-5 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                        {new Date(v.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {verifTotal > 20 && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                <span>{verifTotal.toLocaleString()} total · page {verifPage} of {Math.ceil(verifTotal / 20)}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={verifPage <= 1} onClick={() => setVerifPage((p) => p - 1)}>Prev</Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={verifPage * 20 >= verifTotal} onClick={() => setVerifPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
