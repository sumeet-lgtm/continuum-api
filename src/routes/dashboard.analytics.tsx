import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { StatusBadge } from "@/components/StatusBadge";
import { BarChart3, TrendingUp, MousePointerClick, AlertCircle, GitBranch, Megaphone, Mail, ChevronDown, ChevronRight, Calendar, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/dashboard/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Continuum API" }] }),
  component: AnalyticsPage,
});

interface SendStats {
  sent: number; delivered: number; bounced: number; complained: number;
  opens: number; clicks: number; delivery_rate: number; open_rate: number;
  click_rate: number; bounce_rate: number; complaint_rate: number;
}
interface AccuracyBucket {
  verified_status: "valid" | "risky" | "unknown";
  total_sent: number; bounced: number; complained: number;
  bounce_rate: number | null; complaint_rate: number | null; sample_size_ok: boolean;
}
interface AccuracyStats { buckets: AccuracyBucket[]; measured_accuracy_pct: number | null; min_sample_size: number; }
interface TimelinePoint { date: string; sent: number; delivered: number; bounced: number; }
interface CampaignStat { id: string; subject: string; status: string; sentAt: string | null; totalRecipients: number; sentCount: number; deliveredCount: number; openCount: number; clickCount: number; delivery_rate: number; open_rate: number; click_rate: number; bounce_rate: number; }
interface SequenceStat { id: string; name: string; status: string; total_enrolled: number; active: number; completed: number; replied: number; bounced: number; reply_rate: number; completion_rate: number; }
interface WarmupConfig { enabled: boolean; targetPerDay: number; currentPerDay: number; rampUpDays: number; startedAt: string; }
interface MailboxStat { id: string; username: string; type: string; status: string; sentToday: number; dailyLimit: number; warmupConfig: WarmupConfig | null; }
interface DailyBreakdown { date: string; sent: number; replied: number; bounced: number; }
interface MailboxDetail extends MailboxStat { daily_breakdown: DailyBreakdown[]; }

type Tab = "overview" | "campaigns" | "sequences" | "mailboxes";
type Preset = "7d" | "30d" | "90d" | "custom";

function presetLabel(p: Preset) {
  return p === "7d" ? "Last 7 days" : p === "30d" ? "Last 30 days" : p === "90d" ? "Last 90 days" : "Custom";
}

function presetDateFrom(p: Preset): string {
  const d = new Date();
  if (p === "7d") d.setDate(d.getDate() - 7);
  else if (p === "30d") d.setDate(d.getDate() - 30);
  else if (p === "90d") d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

function SkeletonAnalytics() {
  return (
    <div className="space-y-6">
      <header>
        <Skeleton className="h-8 w-28 mb-2" />
        <Skeleton className="h-4 w-64" />
      </header>
      <div className="flex gap-1 border-b border-border pb-0">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-9 w-24" />)}
      </div>
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-52 w-full" />
      </div>
    </div>
  );
}

function AnalyticsPage() {
  const { primaryKey } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [preset, setPreset] = useState<Preset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [stats, setStats] = useState<SendStats | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyStats | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignStat[]>([]);
  const [sequences, setSequences] = useState<SequenceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [mailboxes, setMailboxes] = useState<MailboxStat[]>([]);
  const [mailboxesLoading, setMailboxesLoading] = useState(false);
  const [expandedMailboxId, setExpandedMailboxId] = useState<string | null>(null);
  const [mailboxDetail, setMailboxDetail] = useState<MailboxDetail | null>(null);
  const [mailboxDetailLoading, setMailboxDetailLoading] = useState(false);

  const effectiveDateFrom = preset === "custom" ? customFrom : presetDateFrom(preset);
  const effectiveDateTo = preset === "custom" && customTo ? customTo : new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    if (preset === "custom" && !customFrom) return;
    setLoading(true);

    const dateFrom = effectiveDateFrom;
    const dateTo = effectiveDateTo;

    Promise.all([
      api.withKey.get<SendStats>(`/v1/analytics/sends?date_from=${dateFrom}&date_to=${dateTo}`, primaryKey.keyRaw),
      api.withKey.get<{ data: TimelinePoint[] }>(`/v1/analytics/sends/timeline?dateFrom=${dateFrom}&dateTo=${dateTo}`, primaryKey.keyRaw),
      api.withKey.get<{ data: CampaignStat[] }>("/v1/analytics/campaigns?limit=20", primaryKey.keyRaw),
      api.withKey.get<{ data: SequenceStat[] }>("/v1/analytics/sequences?limit=20", primaryKey.keyRaw),
      // All-time, not the selected window — accuracy needs the largest sample possible.
      api.withKey.get<AccuracyStats>("/v1/analytics/verification-accuracy", primaryKey.keyRaw),
    ])
      .then(([s, t, c, sq, acc]) => {
        setStats(s);
        setAccuracy(acc);
        setTimeline(t.data ?? []);
        setCampaigns(c.data ?? []);
        setSequences(sq.data ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey, preset, customFrom, customTo]);

  const loadMailboxes = useCallback(() => {
    if (!primaryKey?.keyRaw) return;
    setMailboxesLoading(true);
    api.withKey.get<{ data: MailboxStat[] }>("/v1/analytics/mailboxes", primaryKey.keyRaw)
      .then((r) => setMailboxes(r.data ?? []))
      .catch(() => {})
      .finally(() => setMailboxesLoading(false));
  }, [primaryKey]);

  const loadMailboxDetail = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    if (expandedMailboxId === id) { setExpandedMailboxId(null); setMailboxDetail(null); return; }
    setExpandedMailboxId(id);
    setMailboxDetail(null);
    setMailboxDetailLoading(true);
    try {
      const data = await api.withKey.get<MailboxDetail>(`/v1/analytics/mailboxes/${id}`, primaryKey.keyRaw);
      setMailboxDetail(data);
    } catch { /* ignore */ }
    finally { setMailboxDetailLoading(false); }
  };

  useEffect(() => {
    if (tab === "mailboxes" && mailboxes.length === 0) loadMailboxes();
  }, [tab, mailboxes.length, loadMailboxes]);

  const pct = (n: number) => `${n.toFixed(1)}%`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">Performance across all sends — transactional, campaigns, and sequences.</p>
        </header>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {(["7d", "30d", "90d"] as Preset[]).map((p) => (
              <button
                key={p}
                onClick={() => { setPreset(p); setShowCustom(false); }}
                className={`px-3 py-1.5 transition-colors ${preset === p && !showCustom ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                {presetLabel(p)}
              </button>
            ))}
            <button
              onClick={() => { setPreset("custom"); setShowCustom((v) => !v); }}
              className={`flex items-center gap-1 px-3 py-1.5 transition-colors border-l border-border ${preset === "custom" ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
            >
              <Calendar className="h-3 w-3" />
              Custom
            </button>
          </div>
          {showCustom && (
            <div className="flex items-center gap-2 text-xs">
              <input
                type="date"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                value={customFrom}
                max={customTo || new Date().toISOString().slice(0, 10)}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                value={customTo}
                min={customFrom}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setCustomTo(e.target.value)}
              />
              {customFrom && (
                <Button size="sm" className="h-7 text-xs" onClick={() => { setShowCustom(false); }}>
                  Apply
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["overview", "campaigns", "sequences", "mailboxes"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonAnalytics />
      ) : tab === "overview" ? (
        !stats ? (
          <div className="rounded-lg border border-border bg-card p-10 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No data yet. Send your first email to see analytics.</p>
          </div>
        ) : (
          <>
            {accuracy && <AccuracyCard accuracy={accuracy} />}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Sent" value={stats.sent.toLocaleString()} icon={BarChart3} />
              <StatCard label="Delivery rate" value={pct(stats.delivery_rate)} icon={TrendingUp} color="text-[oklch(0.55_0.16_145)]" />
              <StatCard label="Open rate" value={pct(stats.open_rate)} icon={TrendingUp} color="text-[oklch(0.65_0.16_75)]" />
              <StatCard label="Click rate" value={pct(stats.click_rate)} icon={MousePointerClick} color="text-[oklch(0.65_0.16_75)]" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Delivered" value={stats.delivered.toLocaleString()} />
              <StatCard label="Bounced" value={stats.bounced.toLocaleString()} color="text-[oklch(0.58_0.22_27)]" />
              <StatCard label="Bounce rate" value={pct(stats.bounce_rate)} color={stats.bounce_rate > 5 ? "text-[oklch(0.58_0.22_27)]" : undefined} icon={AlertCircle} />
              <StatCard label="Complaints" value={stats.complained.toLocaleString()} color={stats.complained > 0 ? "text-[oklch(0.58_0.22_27)]" : undefined} />
            </div>
            <ReputationPanel bounce_rate={stats.bounce_rate} complaint_rate={stats.complaint_rate} sent={stats.sent} />
            <div className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-medium mb-4">Daily volume — last 30 days</h2>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="sent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--foreground)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--foreground)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                    <Area type="monotone" dataKey="sent" stroke="var(--foreground)" strokeWidth={2} fill="url(#sent)" dot={false} name="Sent" />
                    <Area type="monotone" dataKey="delivered" stroke="oklch(0.55 0.16 145)" strokeWidth={1.5} fill="none" dot={false} name="Delivered" />
                    <Area type="monotone" dataKey="bounced" stroke="oklch(0.58 0.22 27)" strokeWidth={1.5} fill="none" dot={false} name="Bounced" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )
      ) : tab === "campaigns" ? (
        campaigns.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-10 text-center">
            <Megaphone className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No campaign data yet. Send your first campaign to see stats here.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-medium">Campaign</th>
                  <th className="px-5 py-3 font-medium">Recipients</th>
                  <th className="px-5 py-3 font-medium">Delivery</th>
                  <th className="px-5 py-3 font-medium">Open rate</th>
                  <th className="px-5 py-3 font-medium">Click rate</th>
                  <th className="px-5 py-3 font-medium">Bounce rate</th>
                  <th className="px-5 py-3 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[180px]">{c.subject}</div>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-5 py-3 tabular-nums">{c.totalRecipients.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">{pct(c.delivery_rate)}</td>
                    <td className="px-5 py-3 tabular-nums">{pct(c.open_rate)}</td>
                    <td className="px-5 py-3 tabular-nums">{pct(c.click_rate)}</td>
                    <td className="px-5 py-3 tabular-nums"><span className={c.bounce_rate > 5 ? "text-[oklch(0.58_0.22_27)]" : ""}>{pct(c.bounce_rate)}</span></td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">{c.sentAt ? new Date(c.sentAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === "sequences" ? (
        sequences.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-10 text-center">
            <GitBranch className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No sequence data yet. Create and enroll contacts in a sequence to see stats here.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-medium">Sequence</th>
                  <th className="px-5 py-3 font-medium">Enrolled</th>
                  <th className="px-5 py-3 font-medium">Active</th>
                  <th className="px-5 py-3 font-medium">Completed</th>
                  <th className="px-5 py-3 font-medium">Replied</th>
                  <th className="px-5 py-3 font-medium">Reply rate</th>
                  <th className="px-5 py-3 font-medium">Completion</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[180px]">{s.name}</div>
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-5 py-3 tabular-nums font-semibold">{s.total_enrolled.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">{s.active.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">{s.completed.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">{s.replied.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums font-medium text-[oklch(0.55_0.16_145)]">{pct(s.reply_rate)}</td>
                    <td className="px-5 py-3 tabular-nums">{pct(s.completion_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : mailboxesLoading ? (
        <SkeletonAnalytics />
      ) : mailboxes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Mail className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No mailboxes connected. Add a mailbox under Sequences → Mailboxes to start tracking per-mailbox stats.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border">
            {mailboxes.map((m) => {
              const usePct = m.dailyLimit > 0 ? Math.min(100, Math.round((m.sentToday / m.dailyLimit) * 100)) : 0;
              const isExpanded = expandedMailboxId === m.id;
              return (
                <div key={m.id}>
                  <div
                    className="flex items-center gap-4 px-5 py-4 hover:bg-muted/20 cursor-pointer"
                    onClick={() => loadMailboxDetail(m.id)}
                  >
                    <div className="shrink-0">
                      {isExpanded
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{m.username}</span>
                        <span className="text-xs text-muted-foreground uppercase">{m.type}</span>
                        <StatusBadge status={m.status} />
                        {m.warmupConfig?.enabled && (
                          <span className="text-xs rounded-full bg-muted text-muted-foreground px-2 py-0.5 font-medium">
                            Warmup {m.warmupConfig.currentPerDay}/{m.warmupConfig.targetPerDay}/day
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 bg-muted rounded-full h-1.5 max-w-[200px]">
                          <div
                            className={`h-1.5 rounded-full transition-all ${usePct >= 90 ? "bg-destructive" : usePct >= 70 ? "bg-foreground/60" : "bg-foreground"}`}
                            style={{ width: `${usePct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {m.sentToday} / {m.dailyLimit} sent today
                        </span>
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border bg-muted/10 px-5 py-4">
                      {mailboxDetailLoading ? (
                        <p className="text-xs text-muted-foreground">Loading breakdown…</p>
                      ) : mailboxDetail?.id === m.id && mailboxDetail.daily_breakdown?.length > 0 ? (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Last 30 days</p>
                          <div className="h-40">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={mailboxDetail.daily_breakdown} margin={{ top: 2, right: 4, left: -24, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} tickFormatter={(d: string) => d.slice(5)} />
                                <YAxis tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} allowDecimals={false} />
                                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }} />
                                <Bar dataKey="sent" fill="var(--foreground)" name="Sent" radius={[2, 2, 0, 0]} />
                                <Bar dataKey="replied" fill="oklch(0.55 0.16 145)" name="Replied" radius={[2, 2, 0, 0]} />
                                <Bar dataKey="bounced" fill="oklch(0.58 0.22 27)" name="Bounced" radius={[2, 2, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No activity data yet for this mailbox.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ReputationMeter({
  label, value, warn, critical, unit, ispNote,
}: { label: string; value: number; warn: number; critical: number; unit: string; ispNote: string }) {
  const pctOf = (v: number, max: number) => Math.min(100, (v / max) * 100);
  // Scale: bar spans 0 → critical*1.5
  const max = critical * 1.5;
  const warnPct = pctOf(warn, max);
  const critPct = pctOf(critical, max);
  const valuePct = pctOf(value, max);

  const zone = value >= critical ? "critical" : value >= warn ? "warn" : "good";
  const zoneColor = zone === "critical"
    ? "oklch(0.58 0.22 27)" : zone === "warn"
    ? "oklch(0.78 0.16 75)" : "oklch(0.55 0.16 145)";
  const zoneBg = zone === "critical"
    ? "bg-[oklch(0.96_0.05_27)]" : zone === "warn"
    ? "bg-[oklch(0.97_0.05_75)]" : "bg-[oklch(0.96_0.04_145)]";
  const zoneText = zone === "critical"
    ? "text-[oklch(0.45_0.20_27)]" : zone === "warn"
    ? "text-[oklch(0.50_0.14_75)]" : "text-[oklch(0.35_0.15_145)]";
  const zoneLabel = zone === "critical" ? "Critical" : zone === "warn" ? "Warning" : "Good";

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-mono font-semibold tabular-nums" style={{ color: zoneColor }}>
            {value.toFixed(value < 1 ? 3 : 1)}{unit}
          </span>
          <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${zoneBg} ${zoneText}`}>{zoneLabel}</span>
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
        {/* Green zone */}
        <div className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${warnPct}%`, background: "oklch(0.55 0.16 145 / 0.35)" }} />
        {/* Yellow zone */}
        <div className="absolute inset-y-0 rounded-full"
          style={{ left: `${warnPct}%`, width: `${critPct - warnPct}%`, background: "oklch(0.78 0.16 75 / 0.35)" }} />
        {/* Red zone */}
        <div className="absolute inset-y-0 rounded-full"
          style={{ left: `${critPct}%`, width: `${100 - critPct}%`, background: "oklch(0.58 0.22 27 / 0.35)" }} />
        {/* Value needle */}
        <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${valuePct}%`, background: zoneColor }} />
        {/* Threshold ticks */}
        <div className="absolute inset-y-0 w-px bg-background/60" style={{ left: `${warnPct}%` }} />
        <div className="absolute inset-y-0 w-px bg-background/60" style={{ left: `${critPct}%` }} />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
        <span>0{unit}</span>
        <span className="text-[oklch(0.55_0.14_75)]">{warn}{unit} warn</span>
        <span className="text-[oklch(0.58_0.18_27)]">{critical}{unit} critical</span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-0.5">{ispNote}</p>
    </div>
  );
}

function ReputationPanel({ bounce_rate, complaint_rate, sent }: { bounce_rate: number; complaint_rate: number; sent: number }) {
  const overallZone = bounce_rate >= 5 || complaint_rate >= 0.3
    ? "critical" : bounce_rate >= 2 || complaint_rate >= 0.08
    ? "warn" : "good";
  const overallBg = overallZone === "critical" ? "bg-[oklch(0.96_0.05_27)] border-[oklch(0.88_0.10_27)]"
    : overallZone === "warn" ? "bg-[oklch(0.97_0.05_75)] border-[oklch(0.88_0.12_75)]"
    : "bg-[oklch(0.96_0.04_145)] border-[oklch(0.88_0.10_145)]";
  const overallText = overallZone === "critical" ? "text-[oklch(0.45_0.20_27)]"
    : overallZone === "warn" ? "text-[oklch(0.45_0.14_75)]"
    : "text-[oklch(0.35_0.15_145)]";
  const overallLabel = overallZone === "critical" ? "At risk — action required"
    : overallZone === "warn" ? "Monitor closely"
    : "Healthy";
  const tooFewSends = sent < 50;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Sending Reputation</h2>
        </div>
        {tooFewSends ? (
          <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">Need ≥50 sends for accurate scoring</span>
        ) : (
          <span className={`text-[10px] rounded-full px-2.5 py-1 font-medium border ${overallBg} ${overallText}`}>{overallLabel}</span>
        )}
      </div>
      <div className="flex flex-col sm:flex-row gap-6">
        <ReputationMeter
          label="Bounce rate"
          value={bounce_rate}
          warn={2} critical={5} unit="%"
          ispNote="Gmail blocks at >5% · Yahoo flags above 4% · Best practice: keep below 2%"
        />
        <div className="hidden sm:block w-px bg-border self-stretch" />
        <ReputationMeter
          label="Complaint rate"
          value={complaint_rate}
          warn={0.08} critical={0.3} unit="%"
          ispNote="Gmail blocks at >0.1% · Yahoo hard-blocks at >0.3% · Target: below 0.08%"
        />
      </div>
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

// Measured from this account's own real sends — a standalone verifier
// (ZeroBounce, NeverBounce, MillionVerifier) can't produce this number at
// all, since it never sees whether the "valid" it sold you actually
// delivered. Framed accordingly: this isn't another rate, it's proof.
function AccuracyCard({ accuracy }: { accuracy: AccuracyStats }) {
  const validBucket = accuracy.buckets.find((b) => b.verified_status === "valid");
  const hasScore = accuracy.measured_accuracy_pct !== null && validBucket;

  if (!hasScore) {
    const sent = validBucket?.total_sent ?? 0;
    const remaining = Math.max(0, accuracy.min_sample_size - sent);
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Verification accuracy</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Measured from your own real sends — not a marketing number. Send to {remaining} more
          verified-valid address{remaining === 1 ? "" : "es"} to unlock it ({sent}/{accuracy.min_sample_size}).
        </p>
      </div>
    );
  }

  const pctVal = accuracy.measured_accuracy_pct!;
  const color = pctVal >= 97 ? "text-[oklch(0.55_0.16_145)]" : pctVal >= 90 ? "text-[oklch(0.65_0.16_75)]" : "text-[oklch(0.58_0.22_27)]";

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className={`h-4 w-4 ${color}`} />
            <span className="text-sm font-medium">Verification accuracy</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground max-w-md">
            Of addresses you verified as valid, this % actually delivered — measured from{" "}
            {validBucket.total_sent.toLocaleString()} real sends through your own API key. No
            standalone verifier can show you this; they never see what happens after their check.
          </p>
        </div>
        <div className={`text-4xl font-display font-medium tabular-nums tracking-tight shrink-0 ${color}`}>
          {pctVal}%
        </div>
      </div>
      <AccuracyBreakdown buckets={accuracy.buckets} />
    </div>
  );
}

// Shows bounce rate broken out by what the engine predicted — proof the
// score itself tracks real-world outcomes, not just a valid/invalid coin
// flip. A bucket without enough volume yet shows "—" instead of guessing.
function AccuracyBreakdown({ buckets }: { buckets: AccuracyBucket[] }) {
  const order: AccuracyBucket["verified_status"][] = ["valid", "risky", "unknown"];
  const labels: Record<AccuracyBucket["verified_status"], string> = {
    valid: "Predicted valid", risky: "Predicted risky", unknown: "Predicted unknown",
  };
  const sorted = order.map((s) => buckets.find((b) => b.verified_status === s)).filter((b): b is AccuracyBucket => !!b);
  if (sorted.every((b) => !b.sample_size_ok)) return null;

  return (
    <div className="mt-4 pt-4 border-t border-border grid grid-cols-3 gap-3">
      {sorted.map((b) => (
        <div key={b.verified_status}>
          <div className="text-[11px] text-muted-foreground">{labels[b.verified_status]}</div>
          <div className="mt-0.5 text-sm font-medium tabular-nums">
            {b.sample_size_ok ? `${b.bounce_rate}% bounced` : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {b.sample_size_ok ? `${b.total_sent.toLocaleString()} sent` : `${b.total_sent} sent so far`}
          </div>
        </div>
      ))}
    </div>
  );
}
