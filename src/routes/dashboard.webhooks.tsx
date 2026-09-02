import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/webhooks")({
  head: () => ({ meta: [{ title: "Webhooks — Continuum API" }] }),
  component: WebhooksPage,
});

interface Webhook {
  id: string;
  url: string;
  events: string[] | null;
  isActive: boolean;
  successCount: number | null;
  failureCount: number | null;
}

interface Delivery {
  id: string;
  event: string;
  statusCode: number | null;
  attempts: number | null;
  lastAttemptAt: string | null;
}

const EVENTS: { value: string; label: string; group: string }[] = [
  // Transactional
  { value: "email.delivered", label: "Email delivered", group: "Transactional" },
  { value: "email.bounced", label: "Email bounced (hard/soft)", group: "Transactional" },
  { value: "email.complained", label: "Spam complaint received", group: "Transactional" },
  { value: "email.opened", label: "Email opened", group: "Transactional" },
  { value: "email.clicked", label: "Link clicked", group: "Transactional" },
  { value: "email.unsubscribed", label: "Recipient unsubscribed", group: "Transactional" },
  // Campaigns
  { value: "campaign.sent", label: "Campaign fully sent", group: "Campaigns" },
  { value: "campaign.failed", label: "Campaign failed", group: "Campaigns" },
  // Sequences
  { value: "sequence.enrolled", label: "Contact enrolled in sequence", group: "Sequences" },
  { value: "sequence.replied", label: "Sequence reply received", group: "Sequences" },
  { value: "sequence.completed", label: "Contact completed sequence", group: "Sequences" },
  { value: "sequence.unsubscribed", label: "Contact unsubscribed from sequence", group: "Sequences" },
  // Mailboxes
  { value: "mailbox.error", label: "Mailbox connection error", group: "Mailboxes" },
  { value: "mailbox.daily_limit_reached", label: "Mailbox daily send limit hit", group: "Mailboxes" },
  // Verification & Monitoring
  { value: "verification_complete", label: "Email verified (single)", group: "Verification" },
  { value: "bulk_job_complete", label: "Bulk verification job done", group: "Verification" },
  { value: "monitor_status_change", label: "Monitor status changed", group: "Monitoring" },
];

function WebhooksPage() {
  const { apiKey } = useApiKey();
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([EVENTS[0].value]);
  const [active, setActive] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const load = async () => {
    if (!apiKey?.keyRaw) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/webhooks`, {
        headers: { "X-API-Key": apiKey.keyRaw },
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data?.data ?? data?.webhooks ?? []);
        setHooks(list as Webhook[]);
      } else {
        setHooks([]);
      }
    } catch {
      setHooks([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const addWebhook = async () => {
    if (!apiKey?.keyRaw || !url) return;
    try {
      const res = await fetch(`${API_BASE}/v1/webhooks`, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey.keyRaw,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, events: selected }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error(`Failed to add webhook (${res.status}) ${text}`);
        return;
      }
      // Optimistically add the new hook so the UI updates immediately,
      // even if the GET list is briefly stale on the server.
      try {
        const created = (await res.json()) as Partial<Webhook> & { id?: string };
        if (created && created.id) {
          setHooks((prev) => [
            {
              id: created.id!,
              url: created.url ?? url,
              events: created.events ?? selected,
              isActive: created.isActive ?? true,
              successCount: created.successCount ?? 0,
              failureCount: created.failureCount ?? 0,
            },
            ...prev,
          ]);
        }
      } catch {
        // body wasn't JSON — fall through to refetch
      }
      setUrl("");
      setSelected([EVENTS[0].value]);
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add webhook");
    }
  };

  const toggleActive = async (w: Webhook) => {
    if (!apiKey?.keyRaw) return;
    await fetch(`${API_BASE}/v1/webhooks/${w.id}`, {
      method: "PATCH",
      headers: {
        "X-API-Key": apiKey.keyRaw,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: !w.isActive }),
    });
    await load();
  };

  const remove = async (w: Webhook) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm("Delete this webhook?")) return;
    await fetch(`${API_BASE}/v1/webhooks/${w.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": apiKey.keyRaw },
    });
    if (active?.id === w.id) setActive(null);
    await load();
  };

  const sendPing = async (w: Webhook) => {
    if (!apiKey?.keyRaw) return;
    try {
      await fetch(`${API_BASE}/v1/webhooks/${w.id}/ping`, {
        method: "POST",
        headers: { "X-API-Key": apiKey.keyRaw! },
      });
      toast.success("Test ping sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const openDeliveries = async (w: Webhook) => {
    setActive(w);
    setDeliveries([]);
    const res = await fetch(`${API_BASE}/v1/webhooks/${w.id}/deliveries?limit=50`, { headers: { "X-API-Key": apiKey?.keyRaw ?? "" } });
    const data = res.ok ? await res.json() : [];
    setDeliveries((data ?? []) as Delivery[]);
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">Receive events as they happen.</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!apiKey}>
          <Plus className="h-4 w-4 mr-1.5" /> Add webhook
        </Button>
      </header>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="divide-y divide-border">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center gap-4">
                <div className="h-3 w-56 bg-muted rounded animate-pulse" />
                <div className="h-5 w-14 bg-muted rounded-full animate-pulse ml-auto" />
                <div className="h-3 w-20 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : hooks.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No webhooks configured yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {hooks.map((w) => (
              <li key={w.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => openDeliveries(w)}
                      className="block max-w-full truncate text-left font-mono text-xs hover:underline"
                    >
                      {w.url}
                    </button>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {(w.events ?? []).map((e) => {
                        const label = EVENTS.find((x) => x.value === e)?.label ?? e;
                        return (
                          <span key={e} className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {label}
                          </span>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                      {w.successCount ?? 0} success · {w.failureCount ?? 0} failed
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch checked={w.isActive} onCheckedChange={() => toggleActive(w)} />
                    <Button variant="ghost" size="sm" onClick={() => sendPing(w)}>Test ping</Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(w)}>Delete</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {active && (
        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-medium font-mono truncate">{active.url}</h2>
            <Button variant="ghost" size="sm" onClick={() => setActive(null)}>Close</Button>
          </div>
          {deliveries.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No deliveries yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-5 py-2 font-medium">Event</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Attempts</th>
                  <th className="px-5 py-2 font-medium text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2 text-xs font-mono">{d.event}</td>
                    <td className="px-5 py-2 text-xs tabular-nums">{d.statusCode ?? "—"}</td>
                    <td className="px-5 py-2 text-xs tabular-nums">{d.attempts ?? 1}</td>
                    <td className="px-5 py-2 text-xs text-muted-foreground text-right">
                      {d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add webhook</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="w-url">Endpoint URL</Label>
              <Input
                id="w-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/continuum"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Events</Label>
              <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
                {Array.from(new Set(EVENTS.map((e) => e.group))).map((grp) => (
                  <div key={grp}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{grp}</p>
                    <div className="space-y-1">
                      {EVENTS.filter((e) => e.group === grp).map((e) => {
                        const checked = selected.includes(e.value);
                        return (
                          <label key={e.value} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelected((prev) =>
                                  prev.includes(e.value) ? prev.filter((x) => x !== e.value) : [...prev, e.value],
                                )
                              }
                              className="rounded border-border"
                            />
                            <span className="text-xs">{e.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={addWebhook} disabled={!url || selected.length === 0}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
