import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Activity, Zap, Mail, TrendingUp, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/usage")({
  head: () => ({ meta: [{ title: "Usage & Limits — Continuum API" }] }),
  component: UsagePage,
});

interface UsageData {
  plan: string;
  verifications: { used: number; limit: number; base_limit: number; extra_credits: number; resets_at: string };
  sends: { used: number; limit: number; resets_at: string };
  monitors: { active: number; limit: number };
}

interface DailyPoint { date: string; sent: number; delivered: number; bounced: number }
interface ApiKeyRow {
  id: string; label: string | null; keyPreview: string;
  currentMonthUsage: number; monthlyLimit: number;
  currentMonthSendUsage: number; monthlySendLimit: number;
  isActive: boolean; plan: string;
}

function pct(used: number, limit: number) {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function UsageBar({ used, limit, warn = 70, crit = 90 }: { used: number; limit: number; warn?: number; crit?: number }) {
  const p = pct(used, limit);
  return (
    <div className="space-y-1">
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", p >= crit ? "bg-[oklch(0.58_0.22_27)]" : p >= warn ? "bg-[oklch(0.65_0.16_75)]" : "bg-foreground")}
          style={{ width: `${p}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{used.toLocaleString()} used</span>
        <span>{p}% of {limit.toLocaleString()}</span>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, icon: Icon, warn }: { label: string; value: string; sub?: string; icon: typeof Activity; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn("h-4 w-4", warn ? "text-[oklch(0.58_0.22_27)]" : "text-muted-foreground")} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={cn("text-2xl font-display font-medium tracking-tight tabular-nums", warn && "text-[oklch(0.58_0.22_27)]")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function UsagePage() {
  const { primaryKey, apiKeys } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [timeline, setTimeline] = useState<DailyPoint[]>([]);
  const [allKeys, setAllKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);

    const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    Promise.allSettled([
      api.withKey.get<UsageData>("/v1/usage", primaryKey.keyRaw),
      api.withKey.get<{ data: DailyPoint[] }>(`/v1/analytics/sends/timeline?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: ApiKeyRow[] }>("/v1/api-keys", primaryKey.keyRaw),
    ]).then(([u, t, k]) => {
      if (u.status === "fulfilled") setUsage(u.value);
      if (t.status === "fulfilled") setTimeline((t.value as { data?: DailyPoint[] }).data ?? []);
      if (k.status === "fulfilled") setAllKeys((k.value as { data?: ApiKeyRow[] }).data ?? []);
    }).finally(() => setLoading(false));
  }, [primaryKey]);

  if (loading || !usage) {
    return (
      <div className="space-y-4 max-w-4xl">
        <div className="h-7 w-40 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />)}
        </div>
      </div>
    );
  }

  const vUsed = usage.verifications.used;
  const vLimit = usage.verifications.limit;
  const sUsed = usage.sends.used;
  const sLimit = usage.sends.limit;
  const vPct = pct(vUsed, vLimit);
  const sPct = pct(sUsed, sLimit);
  const resetsAt = usage.verifications.resets_at ? new Date(usage.verifications.resets_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const sendResetsAt = usage.sends.resets_at ? new Date(usage.sends.resets_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-display font-medium tracking-tight">Usage &amp; Limits</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monthly usage for <span className="font-medium capitalize">{usage.plan}</span> plan.
          {resetsAt && <span className="ml-1">Resets {resetsAt}.</span>}
        </p>
      </div>

      {/* Alert banner */}
      {(vPct >= 90 || sPct >= 90) && (
        <div className="flex items-start gap-3 rounded-lg border border-[oklch(0.58_0.22_27)]/30 bg-[oklch(0.58_0.22_27)]/5 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)] mt-0.5 shrink-0" />
          <p className="text-sm text-[oklch(0.58_0.22_27)]">
            {vPct >= 90 && sPct >= 90
              ? "Verification and send credits are almost exhausted."
              : vPct >= 90
              ? "Verification credits are almost exhausted."
              : "Send credits are almost exhausted."}
            {" "}
            <a href="/dashboard/billing" className="underline font-medium">Upgrade or add credits →</a>
          </p>
        </div>
      )}

      {/* Top metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Verifications used" value={vUsed.toLocaleString()} sub={`of ${vLimit.toLocaleString()}`} icon={Zap} warn={vPct >= 90} />
        <MetricCard label="Sends used" value={sUsed.toLocaleString()} sub={`of ${sLimit.toLocaleString()} • resets ${sendResetsAt ?? "—"}`} icon={Mail} warn={sPct >= 90} />
        <MetricCard label="Active monitors" value={usage.monitors.active.toString()} sub={`of ${usage.monitors.limit} limit`} icon={Activity} />
        <MetricCard label="API keys" value={apiKeys.length.toString()} sub={allKeys.length > 0 ? `${allKeys.filter((k) => k.isActive).length} active` : undefined} icon={TrendingUp} />
      </div>

      {/* Progress bars */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-5">
        <h2 className="text-sm font-medium">Monthly quotas</h2>
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-medium mb-1.5">
            <span>Email verifications</span>
            {usage.verifications.extra_credits > 0 && (
              <span className="text-muted-foreground">{usage.verifications.base_limit.toLocaleString()} base + {usage.verifications.extra_credits.toLocaleString()} add-on</span>
            )}
          </div>
          <UsageBar used={vUsed} limit={vLimit} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium mb-1.5">Transactional sends</p>
          <UsageBar used={sUsed} limit={sLimit} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium mb-1.5">Uptime monitors</p>
          <UsageBar used={usage.monitors.active} limit={usage.monitors.limit} />
        </div>
      </div>

      {/* 30-day send volume chart */}
      {timeline.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-medium mb-4">Daily send volume — last 30 days</h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timeline} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad-sent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--foreground)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--foreground)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="sent" stroke="var(--foreground)" strokeWidth={2} fill="url(#grad-sent)" dot={false} name="Sent" />
                <Area type="monotone" dataKey="delivered" stroke="oklch(0.55 0.16 145)" strokeWidth={1.5} fill="none" dot={false} name="Delivered" />
                <Area type="monotone" dataKey="bounced" stroke="oklch(0.58 0.22 27)" strokeWidth={1.5} fill="none" dot={false} name="Bounced" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Per-key breakdown */}
      {allKeys.length > 1 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <h2 className="text-sm font-medium">Usage by API key</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="text-xs text-muted-foreground bg-muted/40 border-b border-border">
                  <th className="px-5 py-2.5 text-left font-medium">Key</th>
                  <th className="px-5 py-2.5 text-left font-medium">Plan</th>
                  <th className="px-5 py-2.5 text-right font-medium tabular-nums">Verifications</th>
                  <th className="px-5 py-2.5 text-right font-medium tabular-nums">Sends</th>
                  <th className="px-5 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {allKeys.map((k) => {
                  const kvPct = pct(k.currentMonthUsage, k.monthlyLimit);
                  const ksPct = pct(k.currentMonthSendUsage, k.monthlySendLimit);
                  return (
                    <tr key={k.id} className="hover:bg-muted/10">
                      <td className="px-5 py-3">
                        <p className="font-medium text-xs">{k.label ?? "Unnamed key"}</p>
                        <p className="text-xs text-muted-foreground font-mono">{k.keyPreview}</p>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-xs capitalize text-muted-foreground">{k.plan}</span>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-xs">
                        <span className={kvPct >= 90 ? "text-[oklch(0.58_0.22_27)] font-medium" : ""}>
                          {k.currentMonthUsage.toLocaleString()} / {k.monthlyLimit.toLocaleString()}
                        </span>
                        <div className="h-1 mt-1 bg-muted rounded-full ml-auto w-16">
                          <div className={cn("h-full rounded-full", kvPct >= 90 ? "bg-[oklch(0.58_0.22_27)]" : "bg-foreground")} style={{ width: `${kvPct}%` }} />
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-xs">
                        <span className={ksPct >= 90 ? "text-[oklch(0.58_0.22_27)] font-medium" : ""}>
                          {k.currentMonthSendUsage.toLocaleString()} / {k.monthlySendLimit.toLocaleString()}
                        </span>
                        <div className="h-1 mt-1 bg-muted rounded-full ml-auto w-16">
                          <div className={cn("h-full rounded-full", ksPct >= 90 ? "bg-[oklch(0.58_0.22_27)]" : "bg-foreground")} style={{ width: `${ksPct}%` }} />
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", k.isActive ? "bg-[oklch(0.95_0.04_145)] text-[oklch(0.35_0.15_145)]" : "bg-muted text-muted-foreground")}>
                          {k.isActive ? "Active" : "Revoked"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Projection */}
      {timeline.length > 7 && (() => {
        const recent = timeline.slice(-7);
        const avgPerDay = recent.reduce((s, d) => s + d.sent, 0) / recent.length;
        const daysLeft = sendResetsAt ? Math.max(0, Math.ceil((new Date(usage.sends.resets_at).getTime() - Date.now()) / 86400000)) : 0;
        const projected = Math.round(sUsed + avgPerDay * daysLeft);
        const projPct = pct(projected, sLimit);
        return projected > sUsed ? (
          <div className="rounded-lg border border-border bg-muted/20 px-5 py-4">
            <h2 className="text-sm font-medium mb-1">Projected month-end usage</h2>
            <p className="text-xs text-muted-foreground">
              At your 7-day average of <span className="font-medium">{Math.round(avgPerDay).toLocaleString()} sends/day</span>,
              you will reach approximately{" "}
              <span className={cn("font-medium", projPct >= 100 ? "text-[oklch(0.58_0.22_27)]" : projPct >= 80 ? "text-[oklch(0.65_0.16_75)]" : "")}>
                {projected.toLocaleString()} sends
              </span>{" "}
              by reset on {sendResetsAt} ({projPct}% of {sLimit.toLocaleString()} limit).
              {projPct >= 100 && (
                <span className="ml-1 text-[oklch(0.58_0.22_27)] font-medium">
                  You are on track to exceed your limit — <a href="/dashboard/billing" className="underline">add credits now</a>.
                </span>
              )}
            </p>
          </div>
        ) : null;
      })()}
    </div>
  );
}
