import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { BarChart3, TrendingUp, MousePointerClick, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/dashboard/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Continuum API" }] }),
  component: AnalyticsPage,
});

interface SendStats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opens: number;
  clicks: number;
  delivery_rate: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
}

interface TimelinePoint { date: string; sent: number; opens: number; clicks: number; }

function AnalyticsPage() {
  const { primaryKey } = useAuth();
  const [stats, setStats] = useState<SendStats | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const dateFrom = thirtyAgo.toISOString().slice(0, 10);

    Promise.all([
      api.withKey.get<SendStats>(`/v1/analytics/sends?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: TimelinePoint[] }>(`/v1/analytics/sends/timeline?date_from=${dateFrom}`, primaryKey.keyRaw),
    ])
      .then(([s, t]) => {
        setStats(s);
        setTimeline(t.data ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey]);

  const pct = (n: number) => `${n.toFixed(1)}%`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">Last 30 days across all sends — transactional, campaigns, and sequences.</p>
      </header>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : !stats ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No data yet. Send your first email to see analytics.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Sent" value={stats.sent.toLocaleString()} icon={BarChart3} />
            <StatCard label="Delivery rate" value={pct(stats.delivery_rate)} icon={TrendingUp} color="text-green-600" />
            <StatCard label="Open rate" value={pct(stats.open_rate)} icon={TrendingUp} color="text-blue-600" />
            <StatCard label="Click rate" value={pct(stats.click_rate)} icon={MousePointerClick} color="text-purple-600" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Delivered" value={stats.delivered.toLocaleString()} />
            <StatCard label="Bounced" value={stats.bounced.toLocaleString()} color="text-red-600" />
            <StatCard label="Bounce rate" value={pct(stats.bounce_rate)} color={stats.bounce_rate > 5 ? "text-red-600" : undefined} icon={AlertCircle} />
            <StatCard label="Complaints" value={stats.complained.toLocaleString()} color={stats.complained > 0 ? "text-red-600" : undefined} />
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium mb-4">Daily volume — last 30 days</h2>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="sent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="oklch(0.145 0 0)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="oklch(0.145 0 0)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "oklch(0.45 0 0)" }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.45 0 0)" }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="sent" stroke="oklch(0.145 0 0)" strokeWidth={2} fill="url(#sent)" dot={false} name="Sent" />
                  <Area type="monotone" dataKey="opens" stroke="oklch(0.55 0.15 250)" strokeWidth={1.5} fill="none" dot={false} name="Opens" />
                  <Area type="monotone" dataKey="clicks" stroke="oklch(0.55 0.15 300)" strokeWidth={1.5} fill="none" dot={false} name="Clicks" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon?: typeof BarChart3; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {Icon && <Icon className={`h-4 w-4 ${color ?? "text-muted-foreground"}`} />}
      </div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${color ?? ""}`}>{value}</div>
    </div>
  );
}
