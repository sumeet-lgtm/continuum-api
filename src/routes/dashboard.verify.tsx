import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

interface HistoryItem {
  email: string;
  status: string;
  score: number | undefined;
  at: string;
}

function VerifyPage() {
  const { apiKey } = useApiKey();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

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
        setHistory((h) =>
          [{ email, status: data.status ?? "unknown", score: data.score, at: new Date().toISOString() }, ...h].slice(0, 5),
        );
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
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Result</h2>
              <StatusBadge status={result.status ?? "unknown"} />
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Score</span>
                <span className="tabular-nums">{result.score ?? 0} / 100</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-foreground transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, result.score ?? 0))}%` }}
                />
              </div>
            </div>
            <div className="mt-5 space-y-4">
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
        <div className="rounded-lg border border-[oklch(0.85_0.12_85)] bg-[oklch(0.97_0.05_95)] p-4 text-sm text-[oklch(0.35_0.08_70)]">
          <strong className="font-medium">Note:</strong> SMTP could not be confirmed for this address (mailbox server unreachable, timed out, or greylisted). Status reflects syntax, MX, and domain-health signals only — do not treat &quot;unknown&quot; as safe to send without a retry.
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-medium">History (this session)</h2>
        </div>
        {history.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">Nothing yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {history.map((h, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5 font-mono text-xs">{h.email}</td>
                  <td className="px-5 py-2.5"><StatusBadge status={h.status} /></td>
                  <td className="px-5 py-2.5 tabular-nums">{h.score ?? "—"}</td>
                  <td className="px-5 py-2.5 text-xs text-muted-foreground">{new Date(h.at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
