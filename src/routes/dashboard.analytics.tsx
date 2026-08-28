import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { StatusBadge } from "@/components/StatusBadge";
import { BarChart3, TrendingUp, MousePointerClick, AlertCircle, GitBranch, Megaphone, Mail, ChevronDown, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/dashboard/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Continuum API" }] }),
  component: AnalyticsPage,
});

interface SendStats {
  sent: number; delivered: number; bounced: number; complained: number;
  opens: number; clicks: number; delivery_rate: number; open_rate: number;
  click_rate: number; bounce_rate: number; complaint_rate: number;
}
interface TimelinePoint { date: string; sent: number; delivered: number; bounced: number; }
interface CampaignStat { id: string; subject: string; status: string; sentAt: string | null; totalRecipients: number; sentCount: number; deliveredCount: number; openCount: number; clickCount: number; delivery_rate: number; open_rate: number; click_rate: number; bounce_rate: number; }
interface SequenceStat { id: string; name: string; status: string; total_enrolled: number; active: number; completed: number; replied: number; bounced: number; reply_rate: number; completion_rate: number; }
interface WarmupConfig { enabled: boolean; targetPerDay: number; currentPerDay: number; rampUpDays: number; startedAt: string; }
interface MailboxStat { id: string; username: string; type: string; status: string; sentToday: number; dailyLimit: number; warmupConfig: WarmupConfig | null; }
interface DailyBreakdown { date: string; sent: number; replied: number; bounced: number; }
interface MailboxDetail extends MailboxStat { daily_breakdown: DailyBreakdown[]; }

type Tab = "overview" | "campaigns" | "sequences" | "mailboxes";

function AnalyticsPage() {
  const { primaryKey } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<SendStats | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignStat[]>([]);
  const [sequences, setSequences] = useState<SequenceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [mailboxes, setMailboxes] = useState<MailboxStat[]>([]);
  const [mailboxesLoading, setMailboxesLoading] = useState(false);
  const [expandedMailboxId, setExpandedMailboxId] = useState<string | null>(null);
  const [mailboxDetail, setMailboxDetail] = useState<MailboxDetail | null>(null);
  const [mailboxDetailLoading, setMailboxDetailLoading] = useState(false);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const dateFrom = thirtyAgo.toISOString().slice(0, 10);

    Promise.all([
      api.withKey.get<SendStats>(`/v1/analytics/sends?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: TimelinePoint[] }>(`/v1/analytics/sends/timeline?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: CampaignStat[] }>("/v1/analytics/campaigns?limit=20", primaryKey.keyRaw),
      api.withKey.get<{ data: SequenceStat[] }>("/v1/analytics/sequences?limit=20", primaryKey.keyRaw),
    ])
      .then(([s, t, c, sq]) => {
        setStats(s);
        setTimeline(t.data ?? []);
        setCampaigns(c.data ?? []);
        setSequences(sq.data ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey]);

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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">Performance across all sends — transactional, campaigns, and sequences.</p>
      </header>

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
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : tab === "overview" ? (
        !stats ? (
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
                    <Area type="monotone" dataKey="delivered" stroke="oklch(0.55 0.15 250)" strokeWidth={1.5} fill="none" dot={false} name="Delivered" />
                    <Area type="monotone" dataKey="bounced" stroke="oklch(0.55 0.15 300)" strokeWidth={1.5} fill="none" dot={false} name="Bounced" />
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
                    <td className="px-5 py-3 tabular-nums"><span className={c.bounce_rate > 5 ? "text-red-600" : ""}>{pct(c.bounce_rate)}</span></td>
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
                    <td className="px-5 py-3 tabular-nums font-medium text-blue-600">{pct(s.reply_rate)}</td>
                    <td className="px-5 py-3 tabular-nums">{pct(s.completion_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : mailboxesLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
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
                                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" vertical={false} />
                                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "oklch(0.45 0 0)" }} tickFormatter={(d: string) => d.slice(5)} />
                                <YAxis tick={{ fontSize: 9, fill: "oklch(0.45 0 0)" }} allowDecimals={false} />
                                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }} />
                                <Bar dataKey="sent" fill="oklch(0.55 0.15 250)" name="Sent" radius={[2, 2, 0, 0]} />
                                <Bar dataKey="replied" fill="oklch(0.55 0.15 150)" name="Replied" radius={[2, 2, 0, 0]} />
                                <Bar dataKey="bounced" fill="oklch(0.55 0.15 30)" name="Bounced" radius={[2, 2, 0, 0]} />
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
