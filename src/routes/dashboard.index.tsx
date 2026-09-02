import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from "recharts";
import { Sparkles, KeyRound, Mail, Activity, CheckCircle2, Circle, ArrowRight, Send, GitBranch } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function useAnimatedNumber(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  const animRef = useRef<number | null>(null);
  const prevTarget = useRef(0);
  useEffect(() => {
    const from = prevTarget.current;
    prevTarget.current = target;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * ease));
      if (t < 1) animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [target, duration]);
  return value;
}

function SkeletonOverview() {
  return (
    <div className="space-y-6">
      <header>
        <Skeleton className="h-8 w-32 mb-2" />
        <Skeleton className="h-4 w-56" />
      </header>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-16" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dashboard/")({
  component: Overview,
});

interface UsageData {
  verifications: { used: number; limit: number; resetsAt: string | null };
  sends: { used: number; limit: number; resetsAt: string | null };
  monitors: { active: number; limit: number };
}

interface HistoryItem {
  id: string;
  email: string;
  status: string;
  score: number | null;
  createdAt: string;
}

function Overview() {
  const { primaryKey, loading: authLoading } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [chartData, setChartData] = useState<{ date: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!primaryKey?.keyRaw) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const [usageRes, histRes] = await Promise.allSettled([
          api.withKey.get<UsageData>("/v1/usage", primaryKey.keyRaw!),
          api.withKey.get<{ history: HistoryItem[]; total: number }>("/v1/history?page=1&limit=10", primaryKey.keyRaw!),
        ]);
        if (usageRes.status === "fulfilled") setUsage(usageRes.value);
        if (histRes.status === "fulfilled") {
          const rows = histRes.value.history ?? [];
          setRecent(rows);
          // Build last-30-days chart from history (simplified — not paginated)
          const buckets = new Map<string, number>();
          for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            buckets.set(d.toISOString().slice(0, 10), 0);
          }
          rows.forEach((r) => {
            const day = r.createdAt.slice(0, 10);
            if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
          });
          setChartData(Array.from(buckets.entries()).map(([date, count]) => ({ date, count })));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [primaryKey]);

  if (authLoading || loading) return <SkeletonOverview />;

  if (!primaryKey) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Your API key is being set up. Contact{" "}
          <a href="mailto:support@continuumapi.com" className="underline">support@continuumapi.com</a>.
        </p>
      </div>
    );
  }

  const plan = primaryKey.plan ?? "free";
  const verifUsed = usage?.verifications.used ?? 0;
  const verifLimit = usage?.verifications.limit ?? primaryKey.monthlyLimit ?? 1000;
  const sendUsed = usage?.sends.used ?? 0;
  const sendLimit = usage?.sends.limit ?? primaryKey.monthlySendLimit ?? 500;
  const pct = verifLimit > 0 ? Math.min(100, (verifUsed / verifLimit) * 100) : 0;
  const empty = recent.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">Your activity this month across all products.</p>
      </header>

      {plan.toLowerCase() === "free" && (
        <Link
          to="/dashboard/billing"
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm hover:bg-muted transition-colors"
        >
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            <span>You&apos;re on the <strong>Free plan</strong>.</span>
          </span>
          <span className="text-xs font-medium underline">Upgrade →</span>
        </Link>
      )}

      {empty && (
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4" />
            <h2 className="text-sm font-semibold">Get started</h2>
          </div>
          <ol className="space-y-2">
            <Step done={true} icon={KeyRound} title="API key ready" desc="Your key is active." to="/dashboard/api-keys" cta="View key" />
            <Step done={false} icon={Mail} title="Verify an email" desc="Run your first verification." to="/dashboard/verify" cta="Try Verify" />
            <Step done={false} icon={Activity} title="Set up monitoring" desc="Watch addresses on a schedule." to="/dashboard/monitoring" cta="Add monitor" />
            <Step done={false} icon={Send} title="Send a transactional email" desc="Use the sending API." to="/dashboard/transactional" cta="Send Email" />
            <Step done={false} icon={GitBranch} title="Create a sequence" desc="Build multi-step cold outreach." to="/dashboard/sequences" cta="New Sequence" />
          </ol>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Verifications used" value={verifUsed} pct={verifLimit > 0 ? (verifUsed / verifLimit) * 100 : 0} />
        <StatCard label="Verif monthly limit" value={verifLimit} />
        <StatCard label="Emails sent" value={sendUsed} pct={sendLimit > 0 ? (sendUsed / sendLimit) * 100 : 0} />
        <StatCard label="Send monthly limit" value={sendLimit} />
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-medium">Verification usage</h2>
          <span className="text-sm tabular-nums text-muted-foreground">{verifUsed.toLocaleString()} / {verifLimit.toLocaleString()}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className={`h-full transition-all ${pct >= 100 ? "bg-[oklch(0.58_0.22_27)]" : pct >= 80 ? "bg-[oklch(0.78_0.16_75)]" : "bg-foreground"}`} style={{ width: `${pct}%` }} />
        </div>
        {usage?.verifications.resetsAt && (
          <p className="mt-2 text-xs text-muted-foreground">
            Resets {new Date(usage.verifications.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-medium mb-3">Recent activity (last 30 days)</h2>
        <div className="h-48">
          {empty ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.1} />
                    <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(d) => d.slice(5)} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} allowDecimals={false} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                />
                <Area type="monotone" dataKey="count" stroke="var(--foreground)" strokeWidth={2} fill="url(#activityFill)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {!empty && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <h2 className="text-sm font-medium">Recent verifications</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-5 py-2 font-medium">Email</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Score</th>
                  <th className="px-5 py-2 font-medium">Checked</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2.5 font-mono text-xs">{r.email}</td>
                    <td className="px-5 py-2.5"><StatusBadge status={r.status} /></td>
                    <td className="px-5 py-2.5 tabular-nums">{r.score ?? "—"}</td>
                    <td className="px-5 py-2.5 text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, pct }: { label: string; value: number; pct?: number }) {
  const displayed = useAnimatedNumber(value);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-display font-medium tabular-nums tracking-tight">
        {displayed.toLocaleString()}
      </div>
      {pct !== undefined && (
        <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${pct >= 100 ? "bg-[oklch(0.58_0.22_27)]" : pct >= 80 ? "bg-[oklch(0.65_0.16_75)]" : "bg-foreground"}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Step({ done, icon: Icon, title, desc, to, cta }: {
  done: boolean; icon: typeof KeyRound; title: string; desc: string; to: string; cta: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
      <div className="mt-0.5">
        {done ? <CheckCircle2 className="h-5 w-5 text-foreground" /> : <Circle className="h-5 w-5 text-muted-foreground" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className={`text-sm font-medium ${done ? "line-through text-muted-foreground" : ""}`}>{title}</p>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Link to={to as "/dashboard"}>
        <Button variant={done ? "outline" : "default"} size="sm" className="gap-1">
          {cta}<ArrowRight className="h-3 w-3" />
        </Button>
      </Link>
    </li>
  );
}
