import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Megaphone, Send, FlaskConical, X, Copy, AlertTriangle, Users, Clock, Edit2, XCircle } from "lucide-react";

export const Route = createFileRoute("/dashboard/campaigns")({
  head: () => ({ meta: [{ title: "Campaigns — Continuum API" }] }),
  component: CampaignsPage,
});

interface Campaign {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  openCount: number;
  clickCount: number;
  createdAt: string;
  scheduledAt: string | null;
  sentAt: string | null;
}

interface MailingList { id: string; name: string; }
interface EmailTemplate { id: string; name: string; subject: string; htmlBody: string; }

function CampaignsPage() {
  const { primaryKey } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "", subject: "", htmlBody: "", listId: "", scheduledAt: "" });
  const [saving, setSaving] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [testTarget, setTestTarget] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [confirmCampaign, setConfirmCampaign] = useState<Campaign | null>(null);
  const [confirming, setConfirming] = useState(false);

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
  };

  useEffect(() => { load(); }, [primaryKey]);

  const resetForm = () => setForm({ name: "", fromName: "", fromEmail: "", subject: "", htmlBody: "", listId: "", scheduledAt: "" });

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
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
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
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
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
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input placeholder="Your May update is here" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
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
            <p className="text-xs text-muted-foreground">Use {"{{first_name}}"}, {"{{email}}"}, {"{{unsubscribe_url}}"} as personalization tokens.</p>
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
                const openRate = c.sentCount > 0 ? ((c.openCount / c.sentCount) * 100).toFixed(1) : "—";
                const clickRate = c.sentCount > 0 ? ((c.clickCount / c.sentCount) * 100).toFixed(1) : "—";
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[200px]">{c.subject}</div>
                      <div className="text-xs text-muted-foreground">{c.fromName} &lt;{c.fromEmail}&gt;</div>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={c.status} /></td>
                    <td className="px-5 py-3 tabular-nums">{c.totalRecipients.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">{openRate}{openRate !== "—" ? "%" : ""}</td>
                    <td className="px-5 py-3 tabular-nums">{clickRate}{clickRate !== "—" ? "%" : ""}</td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : c.scheduledAt ? `Scheduled ${new Date(c.scheduledAt).toLocaleDateString()}` : new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {(c.status === "draft" || c.status === "scheduled") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => {
                            setEditingCampaign(c);
                            setCreating(false);
                            setForm({ name: c.subject, fromName: c.fromName, fromEmail: c.fromEmail, subject: c.subject, htmlBody: "", listId: "", scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16) : "" });
                          }}>
                            <Edit2 className="h-3 w-3" /> Edit
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => { setTestTarget(c.id); setTestEmail(""); }}>
                          <FlaskConical className="h-3 w-3" /> Test
                        </Button>
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
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
