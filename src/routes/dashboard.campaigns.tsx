import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Megaphone, Send, FlaskConical, X, Copy, AlertTriangle, Users } from "lucide-react";

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

function CampaignsPage() {
  const { primaryKey } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "", subject: "", htmlBody: "", listId: "" });
  const [saving, setSaving] = useState(false);
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
  };

  useEffect(() => { load(); }, [primaryKey]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!form.fromName || !form.fromEmail || !form.subject || !form.htmlBody) {
      toast.error("Fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      await api.withKey.post("/v1/campaigns", {
        name: form.name || form.subject,
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
      }, primaryKey.keyRaw);
      toast.success("Campaign created as draft");
      setCreating(false);
      setForm({ name: "", fromName: "", fromEmail: "", subject: "", htmlBody: "", listId: "" });
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
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

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
          <h2 className="text-sm font-semibold">New Campaign</h2>
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
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Campaign"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
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
                      <div className="flex gap-1">
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
