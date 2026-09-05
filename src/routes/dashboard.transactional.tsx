import { createFileRoute } from "@tanstack/react-router";
import React, { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp, FlaskConical, CheckCircle2, Eye, Monitor, Smartphone, Sun, Moon, Search, RefreshCw, ChevronLeft, ChevronRight, BarChart3, Mail, Zap, AlertCircle, MessageSquareOff, MousePointerClick } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/transactional")({
  head: () => ({ meta: [{ title: "Send Email — Continuum" }] }),
  component: TransactionalPage,
});

interface Template { id: string; name: string; subject: string; }

interface MsgRow {
  id: string;
  to: string;
  from: string;
  subject: string | null;
  status: string;
  createdAt: string;
  sentAt: string | null;
  tags: string[];
}

interface MsgEvent {
  id: string;
  type: string;
  occurredAt: string;
}

interface MsgDetail extends MsgRow {
  sesMessageId: string | null;
  events: MsgEvent[];
  trackingEvents: MsgEvent[];
}

interface MsgStats {
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

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  sent:       { dot: "bg-blue-500",   label: "Sent" },
  delivered:  { dot: "bg-emerald-500", label: "Delivered" },
  bounced:    { dot: "bg-rose-500",   label: "Bounced" },
  complained: { dot: "bg-orange-500", label: "Complained" },
  scheduled:  { dot: "bg-violet-500", label: "Scheduled" },
  failed:     { dot: "bg-red-600",    label: "Failed" },
};

const EVENT_ICON: Record<string, string> = {
  delivered:  "✅",
  bounced:    "⛔",
  complained: "🚩",
  open:       "👁",
  click:      "🖱",
};

function StatusDot({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { dot: "bg-muted-foreground", label: status };
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${s.dot}`} />
      {s.label}
    </span>
  );
}

function TransactionalPage() {
  const { primaryKey } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState(() => {
    let defaultFrom = "";
    try { defaultFrom = JSON.parse(localStorage.getItem("cnt_default_from") ?? '""') as string; } catch {}
    return { from: defaultFrom, to: "",
    cc: "",
    bcc: "",
    reply_to: "",
    subject: "",
    html: "",
    text: "",
    template_id: "",
    scheduled_at: "",
    idempotency_key: "",
    };
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewDark, setPreviewDark] = useState(false);
  const [previewMobile, setPreviewMobile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  // Email log state
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [logItems, setLogItems] = useState<MsgRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logFilter, setLogFilter] = useState({ status: "", to: "", subject: "", dateFrom: "", dateTo: "" });
  const [logStats, setLogStats] = useState<MsgStats | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedMsg, setExpandedMsg] = useState<MsgDetail | null>(null);
  const LOG_LIMIT = 20;

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ templates: Template[] }>("/v1/templates", primaryKey.keyRaw)
      .then((r) => setTemplates(r.templates ?? []))
      .catch(() => {});
  }, [primaryKey]);

  const fetchLog = useCallback(async (page = 1, filter = logFilter) => {
    if (!primaryKey?.keyRaw) return;
    setLogLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LOG_LIMIT) });
      if (filter.status) params.set("status", filter.status);
      if (filter.to) params.set("to", filter.to);
      if (filter.subject) params.set("subject", filter.subject);
      if (filter.dateFrom) params.set("date_from", filter.dateFrom);
      if (filter.dateTo) params.set("date_to", filter.dateTo);
      const [logRes, statsRes] = await Promise.all([
        fetch(`https://api.continuumapi.com/v1/messages?${params}`, { headers: { "X-API-Key": primaryKey.keyRaw } }),
        fetch("https://api.continuumapi.com/v1/messages/stats", { headers: { "X-API-Key": primaryKey.keyRaw } }),
      ]);
      if (logRes.ok) {
        const data = await logRes.json() as { data: MsgRow[]; total: number };
        setLogItems(data.data ?? []);
        setLogTotal(data.total ?? 0);
      }
      if (statsRes.ok) setLogStats(await statsRes.json() as MsgStats);
    } catch { /* network hiccup */ }
    finally { setLogLoading(false); }
  }, [primaryKey, LOG_LIMIT]);

  useEffect(() => { fetchLog(1); setLogPage(1); }, [primaryKey?.keyRaw]);

  const fetchMsgDetail = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    if (expandedId === id) { setExpandedId(null); setExpandedMsg(null); return; }
    setExpandedId(id);
    setExpandedMsg(null);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/messages/${id}`, { headers: { "X-API-Key": primaryKey.keyRaw } });
      if (res.ok) setExpandedMsg(await res.json() as MsgDetail);
    } catch { /* */ }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const send = async () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    setResult(null);
    try {
      // The API takes from_name/from_email as separate fields, not a combined
      // "Name <email>" string — this form's single "From" input was sending a
      // literal `from` key the API schema doesn't recognize at all (Zod
      // silently drops unknown fields), so every send here fell through to
      // the generic no-reply@relay.continuumapi.com fallback regardless of
      // what was typed. Parse it the same way the API itself documents.
      const fromMatch = form.from.trim().match(/^(.*)<(.+)>$/);
      const fromEmail = (fromMatch ? fromMatch[2] : form.from).trim();
      const fromName = fromMatch ? fromMatch[1].trim() : undefined;

      const body: Record<string, unknown> = {
        from_email: fromEmail || undefined,
        from_name: fromName || undefined,
        to: form.to.trim(),
        subject: form.subject || undefined,
        html_body: form.html || undefined,
        text_body: form.text || undefined,
        template_id: form.template_id || undefined,
        scheduled_at: form.scheduled_at || undefined,
        idempotency_key: form.idempotency_key || undefined,
        ...(testMode && { test: true }),
      };
      if (form.cc) body.cc = form.cc.split(",").map((s) => s.trim()).filter(Boolean);
      if (form.bcc) body.bcc = form.bcc.split(",").map((s) => s.trim()).filter(Boolean);
      if (form.reply_to) body.reply_to = form.reply_to;

      const res = await api.withKey.post<Record<string, unknown>>("/v1/send", body, primaryKey.keyRaw);
      setResult(res);
      if (testMode) {
        toast.success("Test simulation complete", { description: "Email rendered — no SES call made, no credit used." });
      } else if (form.scheduled_at) {
        toast.success("Email scheduled", { description: `Message ID: ${String(res.id)}` });
      } else {
        toast.success("Email sent", { description: `Message ID: ${String(res.id)}` });
      }
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Send Transactional Email</h1>
        <p className="text-sm text-muted-foreground">
          Send a single email via the API. Supports templates, CC/BCC, reply-to, and scheduled delivery.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>From *</Label>
            <Input placeholder="noreply@yourapp.com" value={form.from} onChange={set("from")} />
          </div>
          <div className="space-y-1.5">
            <Label>To *</Label>
            <Input placeholder="user@example.com" value={form.to} onChange={set("to")} />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input placeholder="Your subject line (or set via template)" value={form.subject} onChange={set("subject")} />
        </div>

        {templates.length > 0 && (
          <div className="space-y-1.5">
            <Label>Template (optional)</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.template_id}
              onChange={set("template_id")}
            >
              <option value="">— None (use HTML below) —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>HTML Body</Label>
            {form.html && (
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Eye className="h-3.5 w-3.5" />
                {showPreview ? "Hide preview" : "Preview"}
              </button>
            )}
          </div>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="<p>Hello {{first_name}},</p>"
            value={form.html}
            onChange={set("html")}
          />
          {showPreview && form.html && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                <button onClick={() => setPreviewMobile((v) => !v)} className={cn("p-1 rounded transition-colors", previewMobile ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
                  {previewMobile ? <Smartphone className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => setPreviewDark((v) => !v)} className={cn("p-1 rounded transition-colors", previewDark ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
                  {previewDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
                </button>
                <span className="text-xs text-muted-foreground ml-auto">{previewMobile ? "375px" : "600px"} · {previewDark ? "Dark" : "Light"}</span>
              </div>
              <div className={cn("flex justify-center py-4", previewDark ? "bg-zinc-900" : "bg-zinc-50")}>
                <iframe
                  key={`${previewDark}-${previewMobile}`}
                  srcDoc={previewDark ? `<html><head><meta name="color-scheme" content="dark"><style>body{margin:0;background:#18181b;color:#f4f4f5}</style></head><body>${form.html}</body></html>` : `<html><head><style>body{margin:0}</style></head><body>${form.html}</body></html>`}
                  sandbox="allow-same-origin"
                  className="rounded border-0"
                  style={{ width: previewMobile ? 375 : 600, minHeight: 300, maxHeight: 600 }}
                  title="Email preview"
                />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Plain Text (optional)</Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Plain text fallback"
            value={form.text}
            onChange={set("text")}
          />
        </div>

        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Advanced options
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-1 border-t border-border">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>CC (comma-separated)</Label>
                <Input placeholder="cc@example.com" value={form.cc} onChange={set("cc")} />
              </div>
              <div className="space-y-1.5">
                <Label>BCC (comma-separated)</Label>
                <Input placeholder="bcc@example.com" value={form.bcc} onChange={set("bcc")} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Reply-To</Label>
                <Input placeholder="replies@yourapp.com" value={form.reply_to} onChange={set("reply_to")} />
              </div>
              <div className="space-y-1.5">
                <Label>Schedule (ISO 8601)</Label>
                <Input type="datetime-local" value={form.scheduled_at} onChange={set("scheduled_at")} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Idempotency Key</Label>
              <Input placeholder="e.g. welcome-user-123 (prevents duplicate sends)" value={form.idempotency_key} onChange={set("idempotency_key")} />
            </div>
          </div>
        )}

        {/* Test mode toggle */}
        <div className="pt-3 border-t border-border">
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={testMode}
                onChange={(e) => setTestMode(e.target.checked)}
              />
              <div className="w-9 h-5 rounded-full border border-border bg-muted peer-checked:bg-foreground transition-colors" />
              <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-background border border-border shadow-sm transition-transform peer-checked:translate-x-4 peer-checked:border-background" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
                Test mode
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Renders the email without sending. No SES call, no credit used.</p>
            </div>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={send} disabled={loading || !primaryKey || !form.from || !form.to}>
            {loading
              ? testMode ? "Simulating…" : "Sending…"
              : testMode ? "Simulate (no send)" : form.scheduled_at ? "Schedule Email" : "Send Email"}
          </Button>
          {testMode && (
            <span className="text-xs text-muted-foreground font-mono">test:true will be sent</span>
          )}
        </div>

        {result && (
          <div className="space-y-3">
            {result.test ? (
              <div className="rounded-lg border border-border bg-muted/30 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/50">
                  <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Simulated response — email was rendered, not sent</span>
                </div>
                <div className="p-4 space-y-3">
                  {Boolean(result.subject) && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Subject</div>
                      <div className="text-sm font-medium">{String(result.subject)}</div>
                    </div>
                  )}
                  {Boolean(result.from) && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">From</div>
                      <div className="text-sm font-mono">{String(result.from)}</div>
                    </div>
                  )}
                  {Boolean(result.html_body) && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Rendered HTML preview</div>
                      <div className="rounded-md border border-border bg-background overflow-hidden max-h-64 overflow-y-auto">
                        <iframe
                          srcDoc={String(result.html_body)}
                          className="w-full"
                          style={{ height: 240, border: "none" }}
                          sandbox="allow-same-origin"
                          title="Email preview"
                        />
                      </div>
                    </div>
                  )}
                  <div className="text-xs font-mono text-muted-foreground pt-1 border-t border-border">
                    id: {String(result.id)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs font-mono text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)] shrink-0" />
                {form.scheduled_at ? "Scheduled" : "Sent"} — message ID: {String(result.id)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 max-w-2xl">
        <h2 className="text-sm font-semibold mb-3">API Reference</h2>
        <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto text-muted-foreground whitespace-pre">{`POST https://api.continuumapi.com/v1/send
X-API-Key: ${primaryKey?.keyRaw ?? "<your-api-key>"}

{
  "from": "noreply@yourapp.com",
  "to": ["recipient@example.com"],
  "cc": ["cc@example.com"],              // optional
  "bcc": ["bcc@example.com"],            // optional
  "reply_to": "support@yourapp.com",     // optional
  "subject": "Your subject",
  "html_body": "<p>Hello {{first_name}}!</p>",
  "mjml_body": "<mjml>...</mjml>",       // optional — compiled server-side
  "text_body": "Hello!",                 // optional
  "template_id": "tmpl_xxx",            // optional — overrides html_body/subject
  "scheduled_at": "2026-09-01T09:00:00Z",  // optional
  "idempotency_key": "welcome-user-123",    // optional
  "test": true                           // optional — renders without sending, no charge
}`}</pre>
      </div>

      {/* Email Log */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-display font-medium tracking-tight">Email Log</h2>
            <p className="text-xs text-muted-foreground">Per-email delivery events — delivered, opened, clicked, bounced</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchLog(logPage)} disabled={logLoading}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", logLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {/* Stats row */}
        {logStats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { icon: Mail,            label: "Sent",       val: logStats.sent,       color: "text-blue-500" },
              { icon: CheckCircle2,    label: "Delivered",  val: logStats.delivered,  color: "text-emerald-500" },
              { icon: Eye,             label: "Opened",     val: logStats.opens,      color: "text-violet-500" },
              { icon: MousePointerClick, label: "Clicked",  val: logStats.clicks,     color: "text-indigo-500" },
              { icon: AlertCircle,     label: "Bounced",    val: logStats.bounced,    color: "text-rose-500" },
              { icon: MessageSquareOff, label: "Spam",      val: logStats.complained, color: "text-orange-500" },
            ].map(({ icon: Icon, label, val, color }) => (
              <div key={label} className="rounded-md border border-border bg-card px-3 py-2.5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Icon className={`h-3.5 w-3.5 ${color}`} />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
                <span className="text-lg font-semibold tabular-nums">{val.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                className="pl-8 pr-3 h-8 rounded-md border border-input bg-background text-sm w-52 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Filter by recipient…"
                value={logFilter.to}
                onChange={(e) => setLogFilter((f) => ({ ...f, to: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && fetchLog(1)}
              />
            </div>
            <input
              className="px-3 h-8 rounded-md border border-input bg-background text-sm w-44 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Filter by subject…"
              value={logFilter.subject}
              onChange={(e) => setLogFilter((f) => ({ ...f, subject: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && fetchLog(1)}
            />
            <select
              className="h-8 rounded-md border border-input bg-background text-sm px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={logFilter.status}
              onChange={(e) => { const newFilter = { ...logFilter, status: e.target.value }; setLogFilter(newFilter); fetchLog(1, newFilter); }}
            >
              <option value="">All statuses</option>
              <option value="sent">Sent</option>
              <option value="delivered">Delivered</option>
              <option value="bounced">Bounced</option>
              <option value="complained">Complained</option>
              <option value="scheduled">Scheduled</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { label: "Last 24h", hours: 24 },
              { label: "Last 7d", hours: 168 },
              { label: "Last 30d", hours: 720 },
            ].map(({ label, hours }) => {
              const from = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 16);
              const to = new Date().toISOString().slice(0, 16);
              const active = logFilter.dateFrom === from;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    const newFilter = active ? { ...logFilter, dateFrom: "", dateTo: "" } : { ...logFilter, dateFrom: from, dateTo: to };
                    setLogFilter(newFilter);
                    fetchLog(1, newFilter);
                  }}
                  className={`h-7 px-2.5 rounded-md text-xs border transition-colors ${active ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}
                >
                  {label}
                </button>
              );
            })}
            <span className="text-xs text-muted-foreground">or</span>
            <input
              type="datetime-local"
              className="h-7 px-2 rounded-md border border-input bg-background text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={logFilter.dateFrom}
              onChange={(e) => setLogFilter((f) => ({ ...f, dateFrom: e.target.value }))}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="datetime-local"
              className="h-7 px-2 rounded-md border border-input bg-background text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={logFilter.dateTo}
              onChange={(e) => setLogFilter((f) => ({ ...f, dateTo: e.target.value }))}
            />
            <Button size="sm" variant="outline" onClick={() => fetchLog(1)}>
              <Search className="h-3.5 w-3.5 mr-1" />
              Search
            </Button>
            {(logFilter.dateFrom || logFilter.dateTo || logFilter.to || logFilter.subject || logFilter.status) && (
              <button
                type="button"
                onClick={() => { const f = { status: "", to: "", subject: "", dateFrom: "", dateTo: "" }; setLogFilter(f); fetchLog(1, f); }}
                className="h-7 px-2.5 rounded-md text-xs border border-border text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Log table */}
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {logLoading && logItems.length === 0 ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="h-3 w-36 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-48 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-16 rounded-full bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          ) : logItems.length === 0 ? (
            <div className="p-8 text-center">
              <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-sm text-muted-foreground">No emails sent yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Send your first email above — it will appear here with live delivery status.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="px-4 py-2 font-medium">To</th>
                    <th className="px-4 py-2 font-medium">Subject</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Sent</th>
                    <th className="px-4 py-2 font-medium w-8" />
                  </tr>
                </thead>
                <tbody>
                  {logItems.map((msg) => (
                    <React.Fragment key={msg.id}>
                      <tr
                        onClick={() => fetchMsgDetail(msg.id)}
                        className={cn("border-b border-border last:border-0 cursor-pointer hover:bg-muted/30 transition-colors", expandedId === msg.id && "bg-muted/40")}
                      >
                        <td className="px-4 py-2.5 font-mono text-xs max-w-[180px] truncate">{msg.to}</td>
                        <td className="px-4 py-2.5 text-xs max-w-[240px] truncate text-muted-foreground">{msg.subject ?? "—"}</td>
                        <td className="px-4 py-2.5"><StatusDot status={msg.status} /></td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                          {msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expandedId === msg.id && "rotate-180")} />
                        </td>
                      </tr>
                      {expandedId === msg.id && (
                        <tr className="bg-muted/20 border-b border-border">
                          <td colSpan={5} className="px-4 py-3">
                            {!expandedMsg ? (
                              <p className="text-xs text-muted-foreground animate-pulse">Loading events…</p>
                            ) : (
                              <div className="space-y-2">
                                <p className="text-xs font-mono text-muted-foreground">ID: {expandedMsg.id}</p>
                                <div className="flex flex-wrap gap-2">
                                  {[...expandedMsg.events, ...expandedMsg.trackingEvents]
                                    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
                                    .map((ev, i) => (
                                      <div key={i} className="flex items-center gap-1.5 rounded-md bg-background border border-border px-2.5 py-1.5 text-xs">
                                        <span>{EVENT_ICON[ev.type] ?? "•"}</span>
                                        <span className="font-medium capitalize">{ev.type}</span>
                                        <span className="text-muted-foreground">{new Date(ev.occurredAt).toLocaleTimeString()}</span>
                                      </div>
                                    ))}
                                  {expandedMsg.events.length === 0 && expandedMsg.trackingEvents.length === 0 && (
                                    <p className="text-xs text-muted-foreground">No delivery events yet — check back shortly.</p>
                                  )}
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {logTotal > LOG_LIMIT && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{logTotal.toLocaleString()} messages total</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={logPage <= 1} onClick={() => { setLogPage((p) => p - 1); fetchLog(logPage - 1); }}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="px-2">Page {logPage} of {Math.ceil(logTotal / LOG_LIMIT)}</span>
              <Button size="sm" variant="ghost" disabled={logPage >= Math.ceil(logTotal / LOG_LIMIT)} onClick={() => { setLogPage((p) => p + 1); fetchLog(logPage + 1); }}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
