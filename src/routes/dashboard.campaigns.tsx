import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Megaphone, Send, FlaskConical, X, Copy, AlertTriangle, Users, Clock, Edit2, XCircle, CheckCircle2, Circle, Monitor, Smartphone, Eye, TrendingUp, BarChart2, ChevronRight, Target } from "lucide-react";

export const Route = createFileRoute("/dashboard/campaigns")({
  head: () => ({ meta: [{ title: "Campaigns — Continuum API" }] }),
  component: CampaignsPage,
});

interface Campaign {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  subjectB?: string | null;
  status: string;
  totalRecipients: number;
  sentCount: number;
  openCount: number;
  clickCount: number;
  openCountB: number;
  clickCountB: number;
  bounceCount: number;
  complaintCount: number;
  trackOpens: boolean;
  trackClicks: boolean;
  createdAt: string;
  scheduledAt: string | null;
  sentAt: string | null;
}

interface MailingList { id: string; name: string; }
interface EmailTemplate { id: string; name: string; subject: string; htmlBody: string; }
interface Segment { id: string; name: string; }
interface SendingDomain { id: string; name: string; status: string; }
interface CampaignHealth {
  health_score: number;
  signals: Array<{ type: "warning" | "critical" | "good"; message: string }>;
  metrics: {
    total_recipients: number; sent: number; delivered: number;
    opened: number; clicked: number; bounced: number; complained: number;
    delivery_rate: number; open_rate: number; click_rate: number;
    bounce_rate: number; complaint_rate: number;
  };
}

function CampaignsPage() {
  const { primaryKey } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "", replyTo: "", subject: "", subjectB: "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: true, trackClicks: true, scheduledAt: "" });
  const [saving, setSaving] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [testTarget, setTestTarget] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [confirmCampaign, setConfirmCampaign] = useState<Campaign | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [healthCampaign, setHealthCampaign] = useState<Campaign | null>(null);
  const [health, setHealth] = useState<CampaignHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [spamResult, setSpamResult] = useState<{ campaign_id: string; spam_score: number; verdict: string; flags: Array<{ severity: string; message: string }> } | null>(null);
  const [spamLoading, setSpamLoading] = useState(false);
  const [retargetResult, setRetargetResult] = useState<{ campaign_id?: string; non_openers: number; total_sent?: number; message: string } | null>(null);
  const [retargetLoading, setRetargetLoading] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: Campaign[] }>("/v1/campaigns?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setCampaigns(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
    api.withKey
      .get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: EmailTemplate[] }>("/v1/templates?limit=50", primaryKey.keyRaw)
      .then((r) => setTemplates(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: Segment[] }>("/v1/segments", primaryKey.keyRaw)
      .then((r) => setSegments(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: SendingDomain[] }>("/v1/domains", primaryKey.keyRaw)
      .then((r) => setDomains((r.data ?? []).filter((d) => d.status === "verified")))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [primaryKey]);

  const resetForm = () => setForm({ name: "", fromName: "", fromEmail: "", replyTo: "", subject: "", subjectB: "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: true, trackClicks: true, scheduledAt: "" });

  const openHealth = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setHealthCampaign(c);
    setHealth(null);
    setHealthLoading(true);
    try {
      const h = await api.withKey.get<CampaignHealth>(`/v1/campaigns/${c.id}/health`, primaryKey.keyRaw);
      setHealth(h);
    } catch { toast.error("Could not load campaign health"); }
    finally { setHealthLoading(false); }
  };

  const runSpamCheck = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setSpamLoading(true);
    setSpamResult(null);
    try {
      const r = await api.withKey.post<typeof spamResult>(`/v1/campaigns/${c.id}/spam-check`, {}, primaryKey.keyRaw);
      setSpamResult(r);
    } catch { toast.error("Could not run spam check"); }
    finally { setSpamLoading(false); }
  };

  const runRetarget = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setRetargetLoading(true);
    setRetargetResult(null);
    try {
      const r = await api.withKey.post<{ campaign_id?: string; non_openers: number; total_sent?: number; message: string }>(`/v1/campaigns/${c.id}/retarget`, {}, primaryKey.keyRaw);
      setRetargetResult(r);
      if (r.campaign_id) { toast.success("Retarget campaign created as draft"); load(); }
      else toast.info(r.message);
    } catch { toast.error("Could not create retarget campaign"); }
    finally { setRetargetLoading(false); }
  };

  const autoTextBody = () => {
    const plain = form.htmlBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    setForm((f) => ({ ...f, textBody: plain }));
  };

  const create = async (asDraft = true) => {
    if (!primaryKey?.keyRaw) return;
    if (!form.fromName || !form.fromEmail || !form.subject || !form.htmlBody) {
      toast.error("Fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name || form.subject,
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        subject_b: form.subjectB || undefined,
        preheader: form.preheader || undefined,
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
        segment_ids: form.segmentId ? [form.segmentId] : [],
        exclude_list_ids: form.excludeListId ? [form.excludeListId] : [],
        reply_to: form.replyTo || undefined,
        text_body: form.textBody || undefined,
        track_opens: form.trackOpens,
        track_clicks: form.trackClicks,
        domain_id: form.domainId || undefined,
      };
      if (!asDraft && form.scheduledAt) payload.scheduled_at = new Date(form.scheduledAt).toISOString();
      const campaign = await api.withKey.post<{ id: string }>("/v1/campaigns", payload, primaryKey.keyRaw);
      if (!asDraft && !form.scheduledAt) {
        await api.withKey.post(`/v1/campaigns/${campaign.id}/send`, {}, primaryKey.keyRaw);
        toast.success("Campaign queued for sending");
      } else if (!asDraft && form.scheduledAt) {
        await api.withKey.post(`/v1/campaigns/${campaign.id}/send`, {}, primaryKey.keyRaw);
        toast.success(`Campaign scheduled for ${new Date(form.scheduledAt).toLocaleString()}`);
      } else {
        toast.success("Campaign saved as draft");
      }
      setCreating(false);
      resetForm();
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateCampaign = async () => {
    if (!primaryKey?.keyRaw || !editingCampaign) return;
    setSaving(true);
    try {
      await api.withKey.patch(`/v1/campaigns/${editingCampaign.id}`, {
        name: form.name || form.subject,
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        subject_b: form.subjectB || undefined,
        preheader: form.preheader || undefined,
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
        reply_to: form.replyTo || undefined,
        text_body: form.textBody || undefined,
        track_opens: form.trackOpens,
        track_clicks: form.trackClicks,
        ...(form.scheduledAt ? { scheduled_at: new Date(form.scheduledAt).toISOString() } : {}),
      }, primaryKey.keyRaw);
      toast.success("Campaign updated");
      setEditingCampaign(null);
      resetForm();
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const cancelSchedule = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.post(`/v1/campaigns/${id}/cancel`, {}, primaryKey.keyRaw);
      toast.success("Campaign reverted to draft");
      setCampaigns((c) => c.map((x) => x.id === id ? { ...x, status: "draft", scheduledAt: null } : x));
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const sendCampaign = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    setConfirming(true);
    try {
      await api.withKey.post(`/v1/campaigns/${id}/send`, {}, primaryKey.keyRaw);
      toast.success("Campaign queued for sending");
      setCampaigns((c) => c.map((x) => x.id === id ? { ...x, status: "sending" } : x));
      setConfirmCampaign(null);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const duplicate = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/campaigns/${id}/duplicate`, {
        method: "POST",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      toast.success("Campaign duplicated as draft");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const sendTest = async () => {
    if (!primaryKey?.keyRaw || !testTarget || !testEmail) return;
    setTestSending(true);
    try {
      await api.withKey.post(`/v1/campaigns/${testTarget}/test`, { to: testEmail }, primaryKey.keyRaw);
      toast.success(`Test sent to ${testEmail}`);
      setTestTarget(null);
      setTestEmail("");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setTestSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Newsletter and broadcast emails to your mailing lists.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Campaign
        </Button>
      </div>

      {(creating || editingCampaign) && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
          <h2 className="text-sm font-semibold">{editingCampaign ? "Edit Campaign" : "New Campaign"}</h2>
          <div className="space-y-1.5">
            <Label>Campaign name</Label>
            <Input placeholder="May Newsletter" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From name</Label>
              <Input placeholder="Acme Inc." value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>From email</Label>
              <Input placeholder="hello@acme.com" value={form.fromEmail} onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))} />
            </div>
          </div>
          {domains.length > 0 && (
            <div className="space-y-1.5">
              <Label>Sending domain <span className="text-muted-foreground font-normal">(optional — defaults to account default)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.domainId}
                onChange={(e) => setForm((f) => ({ ...f, domainId: e.target.value }))}
              >
                <option value="">— account default —</option>
                {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Reply-to <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input placeholder="replies@acme.com" type="email" value={form.replyTo} onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Subject <span className="text-muted-foreground font-normal">(Variant A)</span></Label>
            <Input placeholder="Your May update is here" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Subject B <span className="text-muted-foreground font-normal">(optional — leave blank to skip A/B test)</span></Label>
            <Input
              placeholder="Don't miss your exclusive May offer"
              value={form.subjectB}
              onChange={(e) => setForm((f) => ({ ...f, subjectB: e.target.value }))}
            />
            {form.subjectB && (
              <p className="text-xs text-muted-foreground">A/B test active — 50% of recipients will receive Subject B</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Preheader <span className="text-muted-foreground font-normal">(optional — inbox preview text shown after the subject line)</span></Label>
            <Input
              placeholder="Grab your exclusive offer before it expires..."
              value={form.preheader}
              onChange={(e) => setForm((f) => ({ ...f, preheader: e.target.value }))}
              maxLength={200}
            />
            {form.preheader && (
              <p className="text-xs text-muted-foreground">{form.preheader.length}/200 chars</p>
            )}
          </div>
          {lists.length > 0 && (
            <div className="space-y-1.5">
              <Label>Mailing list</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.listId}
                onChange={(e) => setForm((f) => ({ ...f, listId: e.target.value }))}
              >
                <option value="">— choose a list —</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          {segments.length > 0 && !editingCampaign && (
            <div className="space-y-1.5">
              <Label>Filter by segment <span className="text-muted-foreground font-normal">(optional — narrows the list to matching contacts)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.segmentId}
                onChange={(e) => setForm((f) => ({ ...f, segmentId: e.target.value }))}
              >
                <option value="">— all subscribers in the list —</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {templates.length > 0 && !editingCampaign && (
            <div className="space-y-1.5">
              <Label>Load from template <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                defaultValue=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t) setForm((f) => ({ ...f, subject: t.subject, htmlBody: t.htmlBody }));
                }}
              >
                <option value="">— pick a saved template —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>HTML body</Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[140px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="<p>Hi {{first_name}},</p>"
              value={form.htmlBody}
              onChange={(e) => setForm((f) => ({ ...f, htmlBody: e.target.value }))}
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Use {"{{first_name}}"}, {"{{email}}"}, {"{{unsubscribe_url}}"} as personalization tokens.</p>
              {form.htmlBody && (
                <button onClick={() => setPreview(true)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 shrink-0 ml-2">
                  <Eye className="h-3 w-3" /> Preview
                </button>
              )}
            </div>
          </div>
          {lists.length > 0 && (
            <div className="space-y-1.5">
              <Label>Exclude list <span className="text-muted-foreground font-normal">(optional — these contacts will not receive the campaign)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.excludeListId}
                onChange={(e) => setForm((f) => ({ ...f, excludeListId: e.target.value }))}
              >
                <option value="">— no exclusion list —</option>
                {lists.filter((l) => l.id !== form.listId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Plain text body <span className="text-muted-foreground font-normal">(optional — recommended for deliverability)</span></Label>
              {form.htmlBody && (
                <button type="button" onClick={autoTextBody} className="text-xs text-muted-foreground hover:text-foreground">Auto-generate from HTML</button>
              )}
            </div>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Hi {{first_name}}, ..."
              value={form.textBody}
              onChange={(e) => setForm((f) => ({ ...f, textBody: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-foreground h-4 w-4" checked={form.trackOpens} onChange={(e) => setForm((f) => ({ ...f, trackOpens: e.target.checked }))} />
              <span className="text-sm">Track opens</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-foreground h-4 w-4" checked={form.trackClicks} onChange={(e) => setForm((f) => ({ ...f, trackClicks: e.target.checked }))} />
              <span className="text-sm">Track clicks</span>
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-muted-foreground" /> Schedule send <span className="text-muted-foreground font-normal">(optional — leave blank to save as draft)</span></Label>
            <Input
              type="datetime-local"
              value={form.scheduledAt}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(e) => setForm((f) => ({ ...f, scheduledAt: e.target.value }))}
              className="w-64"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {editingCampaign ? (
              <Button onClick={updateCampaign} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
            ) : form.scheduledAt ? (
              <Button onClick={() => create(false)} disabled={saving} className="gap-1.5">
                <Clock className="h-3.5 w-3.5" />{saving ? "Scheduling…" : `Schedule for ${new Date(form.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
              </Button>
            ) : (
              <>
                <Button onClick={() => create(true)} disabled={saving} variant="outline">{saving ? "Saving…" : "Save as Draft"}</Button>
                <Button onClick={() => create(false)} disabled={saving} className="gap-1.5">
                  <Send className="h-3.5 w-3.5" />{saving ? "Sending…" : "Send Now"}
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => { setCreating(false); setEditingCampaign(null); resetForm(); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* HTML preview modal */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-card border border-border rounded-lg shadow-2xl flex flex-col w-full max-w-4xl h-[80vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium mr-3">Email Preview</span>
                <button
                  onClick={() => setPreviewDevice("desktop")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${previewDevice === "desktop" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Monitor className="h-3.5 w-3.5" /> Desktop
                </button>
                <button
                  onClick={() => setPreviewDevice("mobile")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${previewDevice === "mobile" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Smartphone className="h-3.5 w-3.5" /> Mobile
                </button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground truncate max-w-[300px]">Subject: {form.subject || "(no subject)"}</span>
                <button onClick={() => setPreview(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[oklch(0.93_0.005_270)] flex items-start justify-center py-6">
              <div
                className={`bg-white shadow-lg transition-all ${previewDevice === "mobile" ? "w-[375px]" : "w-full max-w-[680px]"}`}
                style={{ minHeight: "400px" }}
              >
                <iframe
                  srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111}a{color:#0070f3}</style></head><body>${form.htmlBody}</body></html>`}
                  className="w-full border-0"
                  style={{ minHeight: "400px", height: "100%" }}
                  sandbox="allow-same-origin"
                  title="Email preview"
                  onLoad={(e) => {
                    const iframe = e.currentTarget;
                    iframe.style.height = (iframe.contentDocument?.body?.scrollHeight ?? 400) + "px";
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Test send modal */}
      {testTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-sm space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Send Test Email</h2>
              <button onClick={() => { setTestTarget(null); setTestEmail(""); }} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-1.5">
              <Label>Send test to</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendTest(); }}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={sendTest} disabled={testSending || !testEmail} className="gap-1.5">
                <FlaskConical className="h-3.5 w-3.5" />
                {testSending ? "Sending…" : "Send Test"}
              </Button>
              <Button variant="outline" onClick={() => { setTestTarget(null); setTestEmail(""); }}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Send confirmation modal */}
      {confirmCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Confirm Send</h2>
              <button onClick={() => setConfirmCampaign(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subject</span>
                <span className="font-medium max-w-[240px] truncate text-right">{confirmCampaign.subject}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">From</span>
                <span className="font-medium">{confirmCampaign.fromName} &lt;{confirmCampaign.fromEmail}&gt;</span>
              </div>
              {confirmCampaign.scheduledAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Scheduled</span>
                  <span className="font-medium">{new Date(confirmCampaign.scheduledAt).toLocaleString()}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 flex justify-between items-center">
                <span className="text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Recipients</span>
                <span className="font-semibold tabular-nums text-base">{confirmCampaign.totalRecipients.toLocaleString()}</span>
              </div>
            </div>
            {/* Pre-flight checklist */}
            {(() => {
              const checks: Array<{ label: string; pass: boolean; warn?: boolean }> = [
                { label: "Recipients > 0", pass: confirmCampaign.totalRecipients > 0 },
                { label: "Subject line set", pass: Boolean(confirmCampaign.subject) },
                { label: "Subject ≤ 60 chars", pass: confirmCampaign.subject.length <= 60, warn: true },
                { label: "From address set", pass: Boolean(confirmCampaign.fromEmail) },
              ];
              const anyFail = checks.some((c) => !c.pass && !c.warn);
              const anyWarn = checks.some((c) => !c.pass && c.warn);
              if (anyFail || anyWarn) return (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Pre-flight</p>
                  <div className="space-y-1">
                    {checks.map((c) => (
                      <div key={c.label} className={`flex items-center gap-2 text-xs ${c.pass ? "text-[oklch(0.45_0.13_145)]" : c.warn ? "text-[oklch(0.55_0.14_75)]" : "text-[oklch(0.52_0.2_27)]"}`}>
                        {c.pass
                          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
                        {c.label}
                      </div>
                    ))}
                  </div>
                </div>
              );
              return null;
            })()}
            {confirmCampaign.totalRecipients === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                No recipients found. Make sure this campaign is linked to a mailing list with active subscribers.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              This campaign will be sent immediately to{" "}
              <strong>{confirmCampaign.totalRecipients.toLocaleString()} subscriber{confirmCampaign.totalRecipients !== 1 ? "s" : ""}</strong>.
              This action cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => sendCampaign(confirmCampaign.id)}
                disabled={confirming || confirmCampaign.totalRecipients === 0}
                className="gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {confirming ? "Sending…" : `Send to ${confirmCampaign.totalRecipients.toLocaleString()} subscriber${confirmCampaign.totalRecipients !== 1 ? "s" : ""}`}
              </Button>
              <Button variant="outline" onClick={() => setConfirmCampaign(null)} disabled={confirming}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-48 bg-muted rounded animate-pulse" />
              <div className="h-3 w-16 bg-muted rounded animate-pulse" />
              <div className="h-3 w-12 bg-muted rounded animate-pulse ml-auto" />
              <div className="h-3 w-12 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Megaphone className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No campaigns yet. Create your first newsletter campaign.</p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Campaign</Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Campaign</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Recipients</th>
                <th className="px-5 py-3 font-medium">Open rate</th>
                <th className="px-5 py-3 font-medium">Click rate</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const half = c.sentCount > 0 ? Math.ceil(c.sentCount / 2) : 0;
                const halfB = c.sentCount > 0 ? Math.floor(c.sentCount / 2) : 0;
                const openRate = c.sentCount > 0 ? ((c.openCount / c.sentCount) * 100).toFixed(1) : "—";
                const clickRate = c.sentCount > 0 ? ((c.clickCount / c.sentCount) * 100).toFixed(1) : "—";
                const isAB = !!c.subjectB;
                const openRateA = half > 0 ? ((c.openCount / half) * 100).toFixed(1) : "—";
                const clickRateA = half > 0 ? ((c.clickCount / half) * 100).toFixed(1) : "—";
                const openRateB = halfB > 0 ? ((c.openCountB / halfB) * 100).toFixed(1) : "—";
                const clickRateB = halfB > 0 ? ((c.clickCountB / halfB) * 100).toFixed(1) : "—";
                const aWins = isAB && openRateA !== "—" && openRateB !== "—" && parseFloat(openRateA) > parseFloat(openRateB);
                const bWins = isAB && openRateA !== "—" && openRateB !== "—" && parseFloat(openRateB) > parseFloat(openRateA);
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[200px]">{c.subject}</div>
                      {isAB && (
                        <div className="text-xs text-muted-foreground truncate max-w-[200px] mt-0.5">
                          <span className="inline-flex items-center gap-1">
                            <span className="font-mono text-[10px] bg-muted px-1 rounded">B</span>
                            {c.subjectB}
                          </span>
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">{c.fromName} &lt;{c.fromEmail}&gt;</div>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={c.status} /></td>
                    <td className="px-5 py-3 tabular-nums">{c.totalRecipients.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">
                      {isAB ? (
                        <div className="text-xs space-y-0.5">
                          <div className={aWins ? "font-semibold" : ""}><span className="font-mono text-[10px] text-muted-foreground">A</span> {openRateA}{openRateA !== "—" ? "%" : ""} {aWins && "✓"}</div>
                          <div className={bWins ? "font-semibold" : ""}><span className="font-mono text-[10px] text-muted-foreground">B</span> {openRateB}{openRateB !== "—" ? "%" : ""} {bWins && "✓"}</div>
                        </div>
                      ) : (
                        <>{openRate}{openRate !== "—" ? "%" : ""}</>
                      )}
                    </td>
                    <td className="px-5 py-3 tabular-nums">
                      {isAB ? (
                        <div className="text-xs space-y-0.5">
                          <div><span className="font-mono text-[10px] text-muted-foreground">A</span> {clickRateA}{clickRateA !== "—" ? "%" : ""}</div>
                          <div><span className="font-mono text-[10px] text-muted-foreground">B</span> {clickRateB}{clickRateB !== "—" ? "%" : ""}</div>
                        </div>
                      ) : (
                        <>{clickRate}{clickRate !== "—" ? "%" : ""}</>
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : c.scheduledAt ? `Scheduled ${new Date(c.scheduledAt).toLocaleDateString()}` : new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {(c.status === "draft" || c.status === "scheduled") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => {
                            setEditingCampaign(c);
                            setCreating(false);
                            setForm({ name: c.subject, fromName: c.fromName, fromEmail: c.fromEmail, replyTo: "", subject: c.subject, subjectB: c.subjectB ?? "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: c.trackOpens, trackClicks: c.trackClicks, scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16) : "" });
                          }}>
                            <Edit2 className="h-3 w-3" /> Edit
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => { setTestTarget(c.id); setTestEmail(""); }}>
                          <FlaskConical className="h-3 w-3" /> Test
                        </Button>
                        {c.status === "draft" && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => runSpamCheck(c)} disabled={spamLoading}>
                            <AlertTriangle className="h-3 w-3" /> Spam
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => duplicate(c.id)}>
                          <Copy className="h-3 w-3" /> Dupe
                        </Button>
                        {c.status === "draft" && (
                          <Button size="sm" variant="outline" className="gap-1 h-7 px-2 text-xs" onClick={() => setConfirmCampaign(c)}>
                            <Send className="h-3 w-3" /> Send
                          </Button>
                        )}
                        {c.status === "scheduled" && (
                          <Button size="sm" variant="outline" className="gap-1 h-7 px-2 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20" onClick={() => cancelSchedule(c.id)}>
                            <XCircle className="h-3 w-3" /> Unschedule
                          </Button>
                        )}
                        {(c.status === "sent" || c.status === "sending") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => openHealth(c)}>
                            <BarChart2 className="h-3 w-3" /> Stats
                          </Button>
                        )}
                        {c.status === "sent" && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => runRetarget(c)} disabled={retargetLoading}>
                            <Target className="h-3 w-3" /> Retarget
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Campaign health drawer */}
      {healthCampaign && (
        <div className="fixed inset-0 z-40" onClick={() => setHealthCampaign(null)}>
          <div
            className="absolute right-0 top-0 h-full w-[420px] bg-card border-l border-border shadow-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <p className="text-sm font-semibold truncate max-w-[300px]">{healthCampaign.subject}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{healthCampaign.fromName} &lt;{healthCampaign.fromEmail}&gt;</p>
              </div>
              <button onClick={() => setHealthCampaign(null)} className="text-muted-foreground hover:text-foreground ml-3 shrink-0">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {healthLoading ? (
                <div className="space-y-3">
                  {[1,2,3].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
                </div>
              ) : health ? (
                <>
                  {/* Health score */}
                  <div className="flex items-center gap-4">
                    <div className="relative w-16 h-16 shrink-0">
                      <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
                        <circle
                          cx="32" cy="32" r="28" fill="none" strokeWidth="6" strokeLinecap="round"
                          stroke={health.health_score >= 80 ? "oklch(0.55 0.16 145)" : health.health_score >= 50 ? "oklch(0.65 0.16 75)" : "oklch(0.58 0.22 27)"}
                          strokeDasharray={`${(health.health_score / 100) * 175.9} 175.9`}
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">{health.health_score}</span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">
                        {health.health_score >= 80 ? "Healthy" : health.health_score >= 50 ? "At Risk" : "Poor"}
                      </p>
                      <p className="text-xs text-muted-foreground">Deliverability score</p>
                    </div>
                  </div>

                  {/* Signals */}
                  {health.signals.length > 0 && (
                    <div className="space-y-1.5">
                      {health.signals.map((s, i) => (
                        <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                          s.type === "critical" ? "bg-[oklch(0.97_0.04_27)] text-[oklch(0.40_0.18_27)] border border-[oklch(0.88_0.10_27)]" :
                          s.type === "warning" ? "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border border-[oklch(0.88_0.10_75)]" :
                          "bg-[oklch(0.97_0.04_145)] text-[oklch(0.40_0.14_145)] border border-[oklch(0.85_0.10_145)]"
                        }`}>
                          {s.type === "critical" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
                           s.type === "warning" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
                           <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                          {s.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Metrics grid */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Recipients", value: health.metrics.total_recipients.toLocaleString() },
                      { label: "Sent", value: health.metrics.sent.toLocaleString() },
                      { label: "Delivered", value: `${health.metrics.delivery_rate}%` },
                      { label: "Opened", value: `${health.metrics.open_rate}%` },
                      { label: "Clicked", value: `${health.metrics.click_rate}%` },
                      { label: "Bounced", value: `${health.metrics.bounce_rate}%`, warn: health.metrics.bounce_rate > 2 },
                      { label: "Complained", value: `${health.metrics.complaint_rate}%`, warn: health.metrics.complaint_rate > 0.08 },
                    ].map((m) => (
                      <div key={m.label} className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className={`text-lg font-semibold tabular-nums mt-0.5 ${(m as { warn?: boolean }).warn ? "text-[oklch(0.58_0.22_27)]" : ""}`}>{m.value}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No health data available.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Spam check result modal */}
      {spamResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Spam Analysis</h2>
              <button onClick={() => setSpamResult(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-4">
              <div className="relative w-16 h-16 shrink-0">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
                  <circle
                    cx="32" cy="32" r="28" fill="none" strokeWidth="6" strokeLinecap="round"
                    stroke={spamResult.spam_score >= 80 ? "oklch(0.55 0.16 145)" : spamResult.spam_score >= 50 ? "oklch(0.65 0.16 75)" : "oklch(0.58 0.22 27)"}
                    strokeDasharray={`${(spamResult.spam_score / 100) * 175.9} 175.9`}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">{spamResult.spam_score}</span>
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {spamResult.verdict === "likely_inbox" ? "Likely Inbox" : spamResult.verdict === "at_risk" ? "At Risk" : "Likely Spam"}
                </p>
                <p className="text-xs text-muted-foreground">Content spam score</p>
              </div>
            </div>
            {spamResult.flags.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md px-3 py-2 text-xs bg-[oklch(0.97_0.04_145)] text-[oklch(0.40_0.14_145)] border border-[oklch(0.85_0.10_145)]">
                <CheckCircle2 className="h-3.5 w-3.5" /> No spam triggers found
              </div>
            ) : (
              <div className="space-y-1.5">
                {spamResult.flags.map((f, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs border ${
                    f.severity === "high" ? "bg-[oklch(0.97_0.04_27)] text-[oklch(0.40_0.18_27)] border-[oklch(0.88_0.10_27)]" :
                    f.severity === "medium" ? "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.10_75)]" :
                    "bg-muted text-muted-foreground border-border"
                  }`}>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span><span className="font-medium uppercase tracking-wide mr-1">{f.severity}</span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={() => setSpamResult(null)} className="w-full">Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}
