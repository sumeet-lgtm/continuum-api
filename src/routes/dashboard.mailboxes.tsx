import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Send, Zap, TestTube, ZapOff, Mail, TrendingUp, ShieldCheck, ShieldAlert, Shield, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/dashboard/mailboxes")({
  head: () => ({ meta: [{ title: "Mailboxes — Continuum" }] }),
  component: MailboxesPage,
});

interface WarmupConfig { enabled: boolean; currentPerDay: number; targetPerDay: number; }
interface Mailbox {
  id: string;
  type: string;
  username: string;
  dailyLimit: number;
  sentToday: number;
  status: string;
  lastErrorMsg?: string | null;
  lastCheckedAt: string | null;
  warmupConfig?: WarmupConfig | null;
  connectedViaOAuth?: boolean;
}

type HealthTier = "good" | "fair" | "poor";

function computeMailboxHealth(m: Mailbox): { tier: HealthTier; score: number; reason: string } {
  if (m.status === "error") return { tier: "poor", score: 20, reason: "SMTP connection error" };
  let score = 100;
  const reasons: string[] = [];
  // warmup penalty: not warming → docked
  if (!m.warmupConfig?.enabled) { score -= 15; reasons.push("warmup off"); }
  // warmup progress penalty: less than 50% warmed
  else if (m.warmupConfig.currentPerDay / m.warmupConfig.targetPerDay < 0.5) {
    score -= 10; reasons.push("warming up");
  }
  // usage penalty: over 80% of daily limit used
  const usagePct = m.sentToday / m.dailyLimit;
  if (usagePct > 0.9) { score -= 20; reasons.push("near daily limit"); }
  else if (usagePct > 0.75) { score -= 10; reasons.push("high usage today"); }
  // status bonus
  if (m.status !== "active") { score -= 30; reasons.push(`status: ${m.status}`); }
  const tier: HealthTier = score >= 80 ? "good" : score >= 55 ? "fair" : "poor";
  const reason = reasons.length ? reasons.join(", ") : "all systems normal";
  return { tier, score: Math.max(0, score), reason };
}

const HEALTH_STYLES: Record<HealthTier, { icon: typeof ShieldCheck; label: string; cls: string }> = {
  good: { icon: ShieldCheck, label: "Healthy", cls: "text-emerald-600 dark:text-emerald-400" },
  fair: { icon: Shield,      label: "Fair",    cls: "text-amber-600 dark:text-amber-400" },
  poor: { icon: ShieldAlert, label: "Poor",    cls: "text-destructive" },
};

function MailboxesPage() {
  const { primaryKey } = useAuth();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectMode, setConnectMode] = useState<null | "gmail" | "outlook" | "smtp">(null);
  const [form, setForm] = useState({ type: "smtp", host: "", port: "587", username: "", password: "", dailyLimit: "100" });
  const [saving, setSaving] = useState(false);
  const [warmupBusy, setWarmupBusy] = useState<string | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: Mailbox[] }>("/v1/mailboxes", primaryKey.keyRaw)
      .then((r) => setMailboxes(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  // Land back here after the Google/Microsoft consent screen redirects to
  // the backend callback, which redirects here with ?connected= or
  // ?oauth_error= — surface it once, then strip it from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("oauth_error");
    if (connected) {
      toast.success(`${connected === "google" ? "Gmail" : "Outlook"} mailbox connected`);
      load();
    } else if (oauthError) {
      const messages: Record<string, string> = {
        mailbox_limit_reached: "Your plan's mailbox limit is reached — delete one or upgrade to connect another.",
        invalid_or_expired_state: "That connection attempt expired — try connecting again.",
        connect_failed: "Couldn't finish connecting that mailbox. Try again.",
      };
      toast.error(messages[oauthError] ?? "Mailbox connection failed.");
    }
    if (connected || oauthError) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openConnect = (mode: "gmail" | "outlook" | "smtp") => {
    setConnectMode(mode);
    if (mode === "gmail") setForm((f) => ({ ...f, host: "smtp.gmail.com", port: "587", type: "smtp" }));
    else if (mode === "outlook") setForm((f) => ({ ...f, host: "smtp.office365.com", port: "587", type: "smtp" }));
    else setForm((f) => ({ ...f, host: "", port: "587", type: "smtp" }));
  };

  const add = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      // Same class of bug test() below already had to fix once: a 201
      // response here doesn't mean the SMTP credentials actually worked —
      // the route creates the mailbox row either way and reports the real
      // outcome via status/lastErrorMsg in the body. This was showing
      // "Mailbox connected" on a flat-out bad-password rejection.
      const result = await api.withKey.post<{ id: string; type: string; username: string; dailyLimit: number; status: string; lastErrorMsg?: string | null }>("/v1/mailboxes", {
        type: form.type,
        host: form.host || undefined,
        port: form.port ? parseInt(form.port) : undefined,
        username: form.username,
        password: form.password || undefined,
        daily_limit: parseInt(form.dailyLimit),
      }, primaryKey.keyRaw);
      if (result.status === "error") {
        toast.error(result.lastErrorMsg ?? "Mailbox added, but the connection test failed — check the credentials.");
      } else {
        toast.success("Mailbox connected");
      }
      setConnectMode(null);
      setMailboxes((prev) => [{ ...result, sentToday: 0, lastCheckedAt: null }, ...prev]);
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const test = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      // This endpoint always returns HTTP 200 — pass/fail lives in the body,
      // not the status code, so it has to be read explicitly. It was being
      // ignored entirely before, which meant a failed SMTP test still showed
      // a success toast.
      const result = await api.withKey.post<{ ok: boolean; error?: string; imap?: { ok: boolean; error?: string } }>(
        `/v1/mailboxes/${id}/test`, {}, primaryKey.keyRaw,
      );
      if (!result.ok) {
        toast.error(result.error ?? "SMTP connection failed");
      } else if (result.imap && !result.imap.ok) {
        toast.warning("SMTP connected, but IMAP failed — reply detection and warmup auto-reply won't work for this mailbox until that's fixed.");
      } else {
        toast.success("Mailbox connected — SMTP and IMAP both working");
      }
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const toggleWarmup = async (m: Mailbox) => {
    if (!primaryKey?.keyRaw) return;
    setWarmupBusy(m.id);
    try {
      if (m.warmupConfig?.enabled) {
        const res = await fetch(`https://api.continuumapi.com/v1/mailboxes/${m.id}/warmup`, {
          method: "DELETE",
          headers: { "X-API-Key": primaryKey.keyRaw! },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
        }
        toast.success("Warmup disabled");
        setMailboxes((prev) => prev.map((x) => x.id === m.id ? { ...x, warmupConfig: x.warmupConfig ? { ...x.warmupConfig, enabled: false } : null } : x));
      } else {
        await api.withKey.post(`/v1/mailboxes/${m.id}/warmup`, { target_per_day: 40, ramp_up_days: 30 }, primaryKey.keyRaw);
        toast.success("Warmup enabled — ramping up from 5 → 40 emails/day over 30 days");
        setMailboxes((prev) => prev.map((x) => x.id === m.id ? { ...x, warmupConfig: { enabled: true, currentPerDay: 5, targetPerDay: 40 } } : x));
      }
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setWarmupBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Mailboxes</h1>
          <p className="text-sm text-muted-foreground">Connect SMTP or OAuth mailboxes for multi-mailbox rotation in sequences.</p>
        </header>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openConnect("gmail")}>
            <Mail className="h-4 w-4" /> Connect Gmail
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openConnect("outlook")}>
            <Mail className="h-4 w-4" /> Connect Outlook
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => openConnect("smtp")}>
            <Plus className="h-4 w-4" /> Connect SMTP
          </Button>
        </div>
      </div>

      {connectMode && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-lg">
          <h2 className="text-sm font-semibold">
            {connectMode === "gmail" ? "Connect Gmail Mailbox" : connectMode === "outlook" ? "Connect Outlook Mailbox" : "Connect SMTP Mailbox"}
          </h2>

          {/* Gmail App Password instructions */}
          {connectMode === "gmail" && (
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-4 space-y-2">
              <p className="text-xs font-semibold text-blue-800 dark:text-blue-300">You need a Gmail App Password (not your regular password)</p>
              <ol className="text-xs text-blue-700 dark:text-blue-400 space-y-1 list-decimal list-inside">
                <li>Make sure 2-Step Verification is ON for your Google account</li>
                <li>Go to <strong>myaccount.google.com → Security → App Passwords</strong></li>
                <li>Create a new app password — name it "Continuum"</li>
                <li>Copy the 16-character code and paste it below</li>
              </ol>
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 underline underline-offset-2"
              >
                Open App Passwords <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* Outlook App Password instructions */}
          {connectMode === "outlook" && (
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-4 space-y-2">
              <p className="text-xs font-semibold text-blue-800 dark:text-blue-300">You need an Outlook App Password</p>
              <ol className="text-xs text-blue-700 dark:text-blue-400 space-y-1 list-decimal list-inside">
                <li>Go to <strong>account.microsoft.com → Security → Advanced security options</strong></li>
                <li>Under "App passwords," create a new one named "Continuum"</li>
                <li>Copy the password and paste it below</li>
              </ol>
            </div>
          )}

          {connectMode === "smtp" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>SMTP Host</Label>
                <Input placeholder="smtp.example.com" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Port</Label>
                <Input placeholder="587" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Email address</Label>
            <Input placeholder="you@gmail.com" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{connectMode === "smtp" ? "Password" : "App Password"}</Label>
            <Input type="password" placeholder={connectMode === "smtp" ? "••••••••" : "16-character app password"} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Daily sending limit</Label>
            <Input type="number" placeholder="100" value={form.dailyLimit} onChange={(e) => setForm((f) => ({ ...f, dailyLimit: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Connecting…" : "Connect Mailbox"}</Button>
            <Button variant="outline" onClick={() => setConnectMode(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-44 bg-muted rounded animate-pulse" />
              <div className="h-5 w-14 bg-muted rounded-full animate-pulse" />
              <div className="h-2 w-32 bg-muted rounded-full animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : mailboxes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Send className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-2">No mailboxes connected yet.</p>
          <p className="text-xs text-muted-foreground">Connect SMTP, Gmail, or Outlook mailboxes for multi-mailbox rotation in sequences.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {mailboxes.map((m) => (
            <div key={m.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Send className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{m.username}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {m.type} {m.connectedViaOAuth && "· OAuth"} · {m.sentToday}/{m.dailyLimit} today
                    </div>
                    {m.status === "error" && m.lastErrorMsg && (
                      <div className="text-xs text-destructive mt-0.5">{m.lastErrorMsg}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                  {(() => {
                    const h = computeMailboxHealth(m);
                    const cfg = HEALTH_STYLES[h.tier];
                    const Icon = cfg.icon;
                    return (
                      <span className={`flex items-center gap-1 text-xs font-medium ${cfg.cls}`} title={h.reason}>
                        <Icon className="h-3.5 w-3.5" /> {cfg.label}
                      </span>
                    );
                  })()}
                  <StatusBadge status={m.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs h-7 px-2"
                    disabled={warmupBusy === m.id}
                    onClick={() => toggleWarmup(m)}
                  >
                    {m.warmupConfig?.enabled
                      ? <><ZapOff className="h-3 w-3" /> Warmup off</>
                      : <><Zap className="h-3 w-3" /> Enable warmup</>
                    }
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1 h-7 px-2 text-xs" onClick={() => test(m.id)}>
                    <TestTube className="h-3 w-3" /> Test
                  </Button>
                </div>
              </div>
              {/* Daily send bar */}
              <div className="mt-3 space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Daily sends</span>
                  <span>{m.sentToday} / {m.dailyLimit}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-foreground transition-all"
                    style={{ width: `${Math.min(100, (m.sentToday / m.dailyLimit) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Warmup progress bar */}
              {m.warmupConfig?.enabled && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <TrendingUp className="h-3 w-3" /> Warmup progress
                    </span>
                    <span className="font-medium text-foreground">
                      {m.warmupConfig.currentPerDay} / {m.warmupConfig.targetPerDay} per day
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-amber-500/15 overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all"
                      style={{ width: `${Math.min(100, (m.warmupConfig.currentPerDay / m.warmupConfig.targetPerDay) * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {m.warmupConfig.currentPerDay >= m.warmupConfig.targetPerDay
                      ? "Warmup complete — mailbox is fully warmed"
                      : `${Math.round((m.warmupConfig.currentPerDay / m.warmupConfig.targetPerDay) * 100)}% warmed — auto-ramps daily`}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
