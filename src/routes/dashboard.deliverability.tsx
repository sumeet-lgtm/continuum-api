import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ShieldCheck,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  RefreshCw,
  Globe,
  TrendingUp,
  Mail,
  ArrowRight,
  Flame,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/deliverability")({
  head: () => ({ meta: [{ title: "Deliverability Advisor — Continuum API" }] }),
  component: DeliverabilityPage,
});

type SendHealth = {
  sent: number;
  bounce_rate: number;
  complaint_rate: number;
  delivery_rate: number;
  open_rate: number;
};

type Domain = {
  id: string;
  name: string;
  status: string;
  spfStatus: string;
  dkimStatus: string;
  returnPathStatus: string;
};

type WarmupConfig = {
  enabled: boolean;
  targetPerDay: number;
  currentPerDay: number;
  rampUpDays: number;
  startedAt: string;
};

type MailboxSummary = {
  id: string;
  username: string;
  type: string;
  status: string;
  sentToday: number;
  dailyLimit: number;
  warmupConfig: WarmupConfig | null;
};

type Recommendation = {
  id: string;
  severity: "critical" | "warning" | "info" | "good";
  title: string;
  detail: string;
  action?: { label: string; to: string };
};

function warmupProgressPct(wc: WarmupConfig): number {
  const daysRunning = Math.floor((Date.now() - new Date(wc.startedAt).getTime()) / 86_400_000);
  return Math.max(0, Math.min(100, Math.round((daysRunning / Math.max(1, wc.rampUpDays)) * 100)));
}

function computeScore(health: SendHealth | null, domains: Domain[], mailboxes: MailboxSummary[]): number {
  let score = 100;

  if (health && health.sent >= 10) {
    if (health.bounce_rate >= 5) score -= 40;
    else if (health.bounce_rate >= 2) score -= 20;
    else if (health.bounce_rate >= 1) score -= 8;

    if (health.complaint_rate >= 0.3) score -= 30;
    else if (health.complaint_rate >= 0.08) score -= 15;
    else if (health.complaint_rate >= 0.04) score -= 5;
  }

  const verified = domains.filter((d) => d.status === "verified");
  if (domains.length === 0) { score -= 15; }
  else {
    for (const d of verified) {
      if (d.spfStatus !== "verified") score -= 10;
      if (d.dkimStatus !== "verified") score -= 10;
    }
  }

  // A brand-new (or never-warmed) mailbox sending at full volume is the
  // single fastest way to torch a domain's reputation — dock the same as a
  // missing SPF/DKIM record, since it's just as consequential and far more
  // commonly the actual cause when a new sender's deliverability tanks.
  if (mailboxes.length > 0) {
    const active = mailboxes.filter((m) => m.status === "active");
    const warming = active.filter((m) => m.warmupConfig?.enabled);
    if (warming.length === 0) score -= 15;
    else {
      const avgProgress = warming.reduce((s, m) => s + warmupProgressPct(m.warmupConfig!), 0) / warming.length;
      if (avgProgress < 50) score -= 8;
    }
  }

  return Math.max(0, Math.min(100, score));
}

function buildRecommendations(health: SendHealth | null, domains: Domain[], mailboxes: MailboxSummary[]): Recommendation[] {
  const recs: Recommendation[] = [];
  const verified = domains.filter((d) => d.status === "verified");
  const noSpf = verified.filter((d) => d.spfStatus !== "verified");
  const noDkim = verified.filter((d) => d.dkimStatus !== "verified");
  const activeMailboxes = mailboxes.filter((m) => m.status === "active");
  const notWarming = activeMailboxes.filter((m) => !m.warmupConfig?.enabled);
  const stillRamping = activeMailboxes.filter((m) => m.warmupConfig?.enabled && warmupProgressPct(m.warmupConfig) < 100);
  const erroredMailboxes = mailboxes.filter((m) => m.status === "error");

  // Warmup recommendations
  if (erroredMailboxes.length > 0) {
    recs.push({
      id: "mailbox-error",
      severity: "critical",
      title: `${erroredMailboxes.length} mailbox${erroredMailboxes.length > 1 ? "es" : ""} failing to connect`,
      detail: `${erroredMailboxes.map((m) => m.username).join(", ")} — sending and warmup are both paused until the credentials are fixed.`,
      action: { label: "Check mailboxes", to: "/dashboard/mailboxes" },
    });
  }
  if (activeMailboxes.length > 0 && notWarming.length === activeMailboxes.length) {
    recs.push({
      id: "no-warmup",
      severity: "warning",
      title: `Warmup is off on all ${activeMailboxes.length} connected mailbox${activeMailboxes.length > 1 ? "es" : ""}`,
      detail: "A mailbox that hasn't built up sending history yet gets flagged fast at real volume. Turn on warmup and give it 2-4 weeks before running cold campaigns from it.",
      action: { label: "Enable warmup", to: "/dashboard/mailboxes" },
    });
  } else if (notWarming.length > 0) {
    recs.push({
      id: "some-not-warming",
      severity: "info",
      title: `${notWarming.length} of ${activeMailboxes.length} mailboxes aren't warming`,
      detail: `${notWarming.map((m) => m.username).join(", ")} ${notWarming.length > 1 ? "have" : "has"} warmup disabled. Fine if they're already established senders — otherwise turn it on before using them for cold outreach.`,
      action: { label: "Manage mailboxes", to: "/dashboard/mailboxes" },
    });
  }
  if (stillRamping.length > 0) {
    recs.push({
      id: "still-ramping",
      severity: "info",
      title: `${stillRamping.length} mailbox${stillRamping.length > 1 ? "es" : ""} still ramping up`,
      detail: "Warmup is running but hasn't reached full target volume yet. Keep cold-campaign send limits on these mailboxes low until ramp-up completes.",
      action: { label: "View progress", to: "/dashboard/mailboxes" },
    });
  }

  // Domain recommendations
  if (domains.length === 0) {
    recs.push({
      id: "no-domain",
      severity: "warning",
      title: "No sending domain configured",
      detail: "Without a custom sending domain, emails are sent from Continuum's shared infrastructure. Add your own domain for better deliverability and brand trust.",
      action: { label: "Add domain", to: "/dashboard/domains" },
    });
  } else {
    const unverified = domains.filter((d) => d.status !== "verified");
    if (unverified.length > 0) {
      recs.push({
        id: "unverified-domain",
        severity: "warning",
        title: `${unverified.length} domain${unverified.length > 1 ? "s" : ""} pending verification`,
        detail: `${unverified.map((d) => d.name).join(", ")} ${unverified.length > 1 ? "are" : "is"} not yet verified. DNS records may still be propagating.`,
        action: { label: "Check domains", to: "/dashboard/domains" },
      });
    }
    if (noSpf.length > 0) {
      recs.push({
        id: "no-spf",
        severity: "warning",
        title: "SPF record missing",
        detail: `${noSpf.map((d) => d.name).join(", ")} ${noSpf.length > 1 ? "don't have" : "doesn't have"} a valid SPF record. SPF tells receiving servers that Continuum is authorized to send on your behalf.`,
        action: { label: "Fix DNS records", to: "/dashboard/domains" },
      });
    }
    if (noDkim.length > 0) {
      recs.push({
        id: "no-dkim",
        severity: "warning",
        title: "DKIM signing not active",
        detail: `${noDkim.map((d) => d.name).join(", ")} ${noDkim.length > 1 ? "don't have" : "doesn't have"} DKIM configured. DKIM cryptographically signs your emails, significantly boosting inbox placement.`,
        action: { label: "Fix DNS records", to: "/dashboard/domains" },
      });
    }
  }

  // Bounce rate recommendations
  if (health && health.sent >= 10) {
    if (health.bounce_rate >= 5) {
      recs.push({
        id: "bounce-critical",
        severity: "critical",
        title: `Bounce rate critical: ${health.bounce_rate}%`,
        detail: "Your bounce rate is above 5% — Google and Yahoo may pause or block delivery. Clean your list immediately, check your suppression list, and stop sending to unverified addresses.",
        action: { label: "Verify contacts", to: "/dashboard/verify" },
      });
    } else if (health.bounce_rate >= 2) {
      recs.push({
        id: "bounce-warning",
        severity: "warning",
        title: `Bounce rate elevated: ${health.bounce_rate}%`,
        detail: "Google's threshold is 2%, Yahoo's is stricter. Run your list through verification, remove role accounts, and exclude addresses that haven't engaged in 6+ months.",
        action: { label: "Bulk verify", to: "/dashboard/bulk" },
      });
    } else if (health.bounce_rate < 0.5 && health.sent >= 50) {
      recs.push({
        id: "bounce-good",
        severity: "good",
        title: `Bounce rate healthy: ${health.bounce_rate}%`,
        detail: "Your bounce rate is well within safe limits. Keep running verification before importing new lists.",
      });
    }

    // Complaint rate
    if (health.complaint_rate >= 0.3) {
      recs.push({
        id: "complaint-critical",
        severity: "critical",
        title: `Complaint rate critical: ${health.complaint_rate}%`,
        detail: "Spam complaint rates above 0.3% trigger ISP blocks. Review your sending frequency, ensure recipients opted in, and make unsubscribe links prominent.",
        action: { label: "Manage suppressions", to: "/dashboard/suppressions" },
      });
    } else if (health.complaint_rate >= 0.08) {
      recs.push({
        id: "complaint-warning",
        severity: "warning",
        title: `Complaint rate elevated: ${health.complaint_rate}%`,
        detail: "Google Postmaster Tools flags complaint rates above 0.08%. Review your content and frequency. Add one-click unsubscribe headers if not already set.",
        action: { label: "View suppressions", to: "/dashboard/suppressions" },
      });
    } else if (health.complaint_rate < 0.03 && health.sent >= 50) {
      recs.push({
        id: "complaint-good",
        severity: "good",
        title: `Complaint rate healthy: ${health.complaint_rate}%`,
        detail: "Recipients are not marking your emails as spam. Your content and frequency are well-calibrated.",
      });
    }

    // Delivery rate
    if (health.delivery_rate < 90 && health.sent >= 50) {
      recs.push({
        id: "delivery-low",
        severity: "warning",
        title: `Delivery rate below target: ${health.delivery_rate}%`,
        detail: "A healthy transactional delivery rate is 95%+. Check your domain's blacklist status and review bounce categories.",
        action: { label: "Check domains", to: "/dashboard/domains" },
      });
    }
  } else if (!health || health.sent < 10) {
    recs.push({
      id: "no-sends",
      severity: "info",
      title: "Not enough send data yet",
      detail: "Send at least 10 emails to get bounce and complaint rate analysis. Once you do, your reputation metrics will appear here.",
      action: { label: "Send a test email", to: "/dashboard/transactional" },
    });
  }

  // Sort: critical → warning → info → good
  const order = { critical: 0, warning: 1, info: 2, good: 3 };
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}

const SEVERITY_STYLES = {
  critical: {
    container: "border-[oklch(0.85_0.12_27)] bg-[oklch(0.98_0.02_27)]",
    icon: <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)] shrink-0 mt-0.5" />,
    badge: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.85_0.12_27)]",
  },
  warning: {
    container: "border-[oklch(0.88_0.12_75)] bg-[oklch(0.99_0.01_75)]",
    icon: <AlertTriangle className="h-4 w-4 text-[oklch(0.65_0.16_75)] shrink-0 mt-0.5" />,
    badge: "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.12_75)]",
  },
  info: {
    container: "border-border bg-muted/20",
    icon: <Mail className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />,
    badge: "bg-muted text-muted-foreground border-border",
  },
  good: {
    container: "border-[oklch(0.85_0.1_145)] bg-[oklch(0.98_0.02_145)]",
    icon: <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)] shrink-0 mt-0.5" />,
    badge: "bg-[oklch(0.96_0.04_145)] text-[oklch(0.35_0.15_145)] border-[oklch(0.82_0.12_145)]",
  },
};

function ScoreDial({ score }: { score: number }) {
  const color = score >= 80
    ? "oklch(0.55_0.16_145)"
    : score >= 50
    ? "oklch(0.65_0.16_75)"
    : "oklch(0.58_0.22_27)";

  const label = score >= 80 ? "Good" : score >= 50 ? "Fair" : "At Risk";

  const r = 44;
  const circumference = 2 * Math.PI * r;
  const dash = (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="120" height="120" viewBox="0 0 120 120" className="rotate-[-90deg]">
        <circle cx="60" cy="60" r={r} fill="none" stroke="oklch(0.92 0 0)" strokeWidth="12" />
        <circle
          cx="60" cy="60" r={r}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <div className="text-center -mt-[78px] mb-[58px]">
        <div className="text-3xl font-display font-semibold tabular-nums" style={{ color }}>
          {score}
        </div>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

type InboxProvider = {
  provider: string;
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
  complaint_rate: number;
};

function DeliverabilityPage() {
  const { primaryKey } = useAuth();
  const [health, setHealth] = useState<SendHealth | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [providers, setProviders] = useState<InboxProvider[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!primaryKey?.keyRaw) return;
    const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [healthRes, domainsRes, providersRes, mailboxesRes] = await Promise.allSettled([
      api.withKey.get<SendHealth>(`/v1/analytics/sends?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: Domain[] }>("/v1/domains", primaryKey.keyRaw),
      api.withKey.get<{ data: InboxProvider[] }>(`/v1/analytics/inbox-providers?date_from=${dateFrom}`, primaryKey.keyRaw),
      api.withKey.get<{ data: MailboxSummary[] }>("/v1/analytics/mailboxes", primaryKey.keyRaw),
    ]);
    if (healthRes.status === "fulfilled") setHealth(healthRes.value);
    if (domainsRes.status === "fulfilled") setDomains(domainsRes.value.data ?? []);
    if (providersRes.status === "fulfilled") setProviders(providersRes.value.data ?? []);
    if (mailboxesRes.status === "fulfilled") setMailboxes(mailboxesRes.value.data ?? []);
  }, [primaryKey]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  };

  const score = loading ? null : computeScore(health, domains, mailboxes);
  const recs = loading ? [] : buildRecommendations(health, domains, mailboxes);
  const criticalCount = recs.filter((r) => r.severity === "critical").length;
  const warningCount = recs.filter((r) => r.severity === "warning").length;

  return (
    <div className="space-y-6 max-w-3xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Deliverability Advisor</h1>
          <p className="text-sm text-muted-foreground">
            Proactive recommendations based on your sending reputation (last 30 days).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing || loading} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Score + summary bar */}
          <div className="rounded-lg border border-border bg-card p-6 flex items-center gap-8 flex-wrap">
            {score !== null && <ScoreDial score={score} />}
            <div className="flex-1 min-w-0 space-y-4">
              <div>
                <p className="text-sm font-medium">
                  {criticalCount > 0
                    ? `${criticalCount} critical issue${criticalCount > 1 ? "s" : ""} need${criticalCount === 1 ? "s" : ""} attention`
                    : warningCount > 0
                    ? `${warningCount} warning${warningCount > 1 ? "s" : ""} to address`
                    : "Your sending reputation looks healthy"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Score is based on bounce rate, complaint rate, domain authentication, and mailbox warmup.
                </p>
              </div>
              {health && health.sent >= 10 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Metric label="Sent (30d)" value={health.sent.toLocaleString()} />
                  <Metric label="Delivery rate" value={`${health.delivery_rate}%`}
                    color={health.delivery_rate >= 95 ? "good" : health.delivery_rate >= 90 ? "warn" : "bad"} />
                  <Metric label="Bounce rate" value={`${health.bounce_rate}%`}
                    color={health.bounce_rate < 2 ? "good" : health.bounce_rate < 5 ? "warn" : "bad"} />
                  <Metric label="Complaint rate" value={`${health.complaint_rate}%`}
                    color={health.complaint_rate < 0.08 ? "good" : health.complaint_rate < 0.3 ? "warn" : "bad"} />
                </div>
              )}
            </div>
          </div>

          {/* Domain status strip */}
          {domains.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <h2 className="text-sm font-medium">Sending domains</h2>
              </div>
              <div className="divide-y divide-border">
                {domains.map((d) => {
                  const issues = [
                    d.spfStatus !== "verified" && "SPF",
                    d.dkimStatus !== "verified" && "DKIM",
                    d.status !== "verified" && "Verification pending",
                  ].filter(Boolean);
                  return (
                    <div key={d.id} className="flex items-center justify-between px-5 py-3 gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`h-2 w-2 rounded-full shrink-0 ${d.status === "verified" && issues.length === 0 ? "bg-[oklch(0.55_0.16_145)]" : "bg-[oklch(0.65_0.16_75)]"}`} />
                        <code className="text-sm font-mono truncate">{d.name}</code>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {["SPF", "DKIM"].map((check) => {
                          const ok = check === "SPF" ? d.spfStatus === "verified" : d.dkimStatus === "verified";
                          return (
                            <span key={check} className={`text-[10px] font-medium rounded-full border px-1.5 py-0.5 ${ok ? "bg-[oklch(0.96_0.04_145)] text-[oklch(0.35_0.15_145)] border-[oklch(0.82_0.12_145)]" : "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.12_75)]"}`}>
                              {ok ? "✓" : "✗"} {check}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Mailbox warmup status */}
          {mailboxes.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                <Flame className="h-3.5 w-3.5 text-muted-foreground" />
                <h2 className="text-sm font-medium">Mailbox warmup</h2>
              </div>
              <div className="divide-y divide-border">
                {mailboxes.map((m) => {
                  const wc = m.warmupConfig;
                  const progress = wc?.enabled ? warmupProgressPct(wc) : null;
                  return (
                    <div key={m.id} className="flex items-center justify-between px-5 py-3 gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`h-2 w-2 rounded-full shrink-0 ${
                            m.status === "error"
                              ? "bg-[oklch(0.58_0.22_27)]"
                              : progress === 100
                              ? "bg-[oklch(0.55_0.16_145)]"
                              : progress !== null
                              ? "bg-[oklch(0.65_0.16_75)]"
                              : "bg-muted-foreground/40"
                          }`}
                        />
                        <code className="text-sm font-mono truncate">{m.username}</code>
                      </div>
                      {m.status === "error" ? (
                        <span className="text-[10px] font-medium rounded-full border px-1.5 py-0.5 bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.85_0.12_27)] shrink-0">
                          Connection error
                        </span>
                      ) : progress === null ? (
                        <span className="text-[10px] font-medium rounded-full border px-1.5 py-0.5 bg-muted text-muted-foreground border-border shrink-0">
                          Warmup off
                        </span>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[oklch(0.55_0.16_145)] transition-[width]"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-medium text-muted-foreground tabular-nums w-16 text-right">
                            {progress}% · {wc!.currentPerDay}/{wc!.targetPerDay} per day
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Inbox provider breakdown */}
          {providers.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                <h2 className="text-sm font-medium">Inbox provider breakdown</h2>
                <span className="text-xs text-muted-foreground ml-auto">Last 30 days</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2 text-left font-medium text-muted-foreground">Provider</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground tabular-nums">Sent</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Delivery</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Open</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Click</th>
                      <th className="px-4 py-2 text-right font-medium text-muted-foreground">Bounce</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.slice(0, 8).map((p) => {
                      const deliveryColor = p.delivery_rate >= 95 ? "text-[oklch(0.55_0.16_145)]" : p.delivery_rate >= 85 ? "text-[oklch(0.65_0.16_75)]" : "text-[oklch(0.58_0.22_27)]";
                      const bounceColor = p.bounce_rate <= 2 ? "text-foreground" : p.bounce_rate <= 5 ? "text-[oklch(0.65_0.16_75)]" : "text-[oklch(0.58_0.22_27)]";
                      return (
                        <tr key={p.provider} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5 font-medium">{p.provider}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{p.sent.toLocaleString()}</td>
                          <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${deliveryColor}`}>{p.delivery_rate}%</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{p.open_rate}%</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{p.click_rate}%</td>
                          <td className={`px-4 py-2.5 text-right tabular-nums ${bounceColor}`}>{p.bounce_rate}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recommendations */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Recommendations</h2>
            </div>
            {recs.length === 0 && (
              <div className="rounded-lg border border-border bg-card p-6 flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-[oklch(0.55_0.16_145)]" />
                <p className="text-sm text-muted-foreground">No issues found. Your setup looks good.</p>
              </div>
            )}
            {recs.map((rec) => {
              const style = SEVERITY_STYLES[rec.severity];
              return (
                <div key={rec.id} className={`rounded-lg border p-4 flex gap-3 ${style.container}`}>
                  {style.icon}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{rec.title}</p>
                      <span className={`text-[10px] font-medium rounded-full border px-1.5 py-0.5 uppercase tracking-wide ${style.badge}`}>
                        {rec.severity}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{rec.detail}</p>
                    {rec.action && (
                      <Link to={rec.action.to} className="inline-flex items-center gap-1 text-xs font-medium mt-1 hover:underline">
                        {rec.action.label} <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: "good" | "warn" | "bad";
}) {
  const textColor = color === "good"
    ? "text-[oklch(0.55_0.16_145)]"
    : color === "warn"
    ? "text-[oklch(0.65_0.16_75)]"
    : color === "bad"
    ? "text-[oklch(0.58_0.22_27)]"
    : "text-foreground";

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <p className={`text-base font-display font-semibold tabular-nums ${textColor}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}
