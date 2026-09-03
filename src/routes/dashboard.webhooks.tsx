import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus, CheckCircle2, XCircle, RefreshCw, KeyRound, Copy, Check, ChevronRight, X } from "lucide-react";
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
  delivered: boolean;
  failedPermanently: boolean;
  nextRetryAt: string | null;
}

interface DeliveryDetail extends Delivery {
  payload: unknown;
  responseBody: string | null;
  responseHeaders: Record<string, string> | null;
  errorMessage: string | null;
  latencyMs: number | null;
  attempts_detail?: Array<{
    id: string;
    statusCode: number | null;
    responseBody: string | null;
    responseHeaders: Record<string, string> | null;
    latencyMs: number | null;
    attemptedAt: string;
    errorMessage: string | null;
  }>;
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

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-muted transition-colors"
    >
      {done ? <Check className="h-3 w-3 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function WebhooksPage() {
  const { apiKey } = useApiKey();
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([EVENTS[0].value]);
  const [active, setActive] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inspecting, setInspecting] = useState<DeliveryDetail | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);

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
    const data = res.ok ? await res.json() : {};
    setDeliveries(((data as { data?: Delivery[] }).data ?? data ?? []) as Delivery[]);
  };

  const rotateSecret = async (w: Webhook) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm(`Rotate the signing secret for ${w.url}? Your current secret will stop working immediately.`)) return;
    setRotating(w.id);
    try {
      const res = await fetch(`${API_BASE}/v1/webhooks/${w.id}/rotate-secret`, {
        method: "POST",
        headers: { "X-API-Key": apiKey.keyRaw },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Rotation failed");
      }
      const data = await res.json() as { secret: string };
      setRotatedSecret(data.secret);
      setCopied(false);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setRotating(null);
    }
  };

  const inspectDelivery = async (webhookId: string, deliveryId: string) => {
    if (!apiKey?.keyRaw) return;
    setInspectLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/webhooks/${webhookId}/deliveries/${deliveryId}`, {
        headers: { "X-API-Key": apiKey.keyRaw },
      });
      if (res.ok) {
        const data = await res.json() as DeliveryDetail;
        setInspecting(data);
      } else {
        toast.error("Could not load delivery details");
      }
    } catch {
      toast.error("Failed to load delivery");
    } finally {
      setInspectLoading(false);
    }
  };

  const retryDelivery = async (webhookId: string, deliveryId: string) => {
    if (!apiKey?.keyRaw) return;
    try {
      const res = await fetch(`${API_BASE}/v1/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, {
        method: "POST",
        headers: { "X-API-Key": apiKey.keyRaw },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Retry failed");
      }
      toast.success("Retry enqueued");
      if (active) await openDeliveries(active);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
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
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-muted-foreground">No webhooks configured yet.</p>
            <p className="text-xs text-muted-foreground">Receive real-time event notifications when emails are delivered, bounced, or verified.</p>
            <Button size="sm" onClick={() => setOpen(true)} className="mt-1">
              <Plus className="h-4 w-4 mr-1.5" /> Add webhook
            </Button>
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
                  <div className="flex items-center gap-2">
                    <Switch checked={w.isActive} onCheckedChange={() => toggleActive(w)} />
                    <Button variant="ghost" size="sm" onClick={() => sendPing(w)}>Ping</Button>
                    <Button variant="ghost" size="sm" title="Rotate signing secret"
                      onClick={() => rotateSecret(w)} disabled={rotating === w.id}>
                      <KeyRound className={`h-3.5 w-3.5 mr-1 ${rotating === w.id ? "animate-spin" : ""}`} />
                      Rotate
                    </Button>
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
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                  <th className="px-5 py-2 font-medium">Event</th>
                  <th className="px-5 py-2 font-medium">Result</th>
                  <th className="px-5 py-2 font-medium">HTTP</th>
                  <th className="px-5 py-2 font-medium">Attempts</th>
                  <th className="px-5 py-2 font-medium text-right">Last attempt</th>
                  <th className="px-5 py-2 font-medium text-right"></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2 text-xs font-mono">{d.event.replace(/_/g, ".")}</td>
                    <td className="px-5 py-2">
                      {d.delivered ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[oklch(0.55_0.16_145)]">
                          <CheckCircle2 className="h-3 w-3" /> Delivered
                        </span>
                      ) : d.failedPermanently ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[oklch(0.58_0.22_27)]">
                          <XCircle className="h-3 w-3" /> Failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-[oklch(0.65_0.16_75)]">
                          <RefreshCw className="h-3 w-3" /> Retrying
                          {d.nextRetryAt ? ` · ${new Date(d.nextRetryAt).toLocaleTimeString()}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-xs tabular-nums text-muted-foreground">
                      {d.statusCode ? `HTTP ${d.statusCode}` : "—"}
                    </td>
                    <td className="px-5 py-2 text-xs tabular-nums text-muted-foreground">{d.attempts ?? 1} attempt{(d.attempts ?? 1) !== 1 ? "s" : ""}</td>
                    <td className="px-5 py-2 text-xs text-muted-foreground text-right">
                      {d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {(!d.delivered && (d.failedPermanently || d.attempts !== null)) && (
                          <button
                            onClick={() => retryDelivery(active!.id, d.id)}
                            className="text-xs text-muted-foreground hover:text-foreground underline"
                          >
                            Retry
                          </button>
                        )}
                        <button
                          onClick={() => inspectDelivery(active!.id, d.id)}
                          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                          title="Inspect payload"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Delivery inspector panel */}
      {(inspecting || inspectLoading) && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Delivery inspector</span>
              {inspecting && (
                <>
                  <span className="font-mono text-xs text-muted-foreground">{inspecting.event.replace(/_/g, ".")}</span>
                  {inspecting.statusCode && (
                    <span className={`text-xs font-bold tabular-nums ${inspecting.statusCode >= 200 && inspecting.statusCode < 300 ? "text-[oklch(0.55_0.16_145)]" : "text-[oklch(0.58_0.22_27)]"}`}>
                      HTTP {inspecting.statusCode}
                    </span>
                  )}
                  {inspecting.latencyMs && (
                    <span className="text-xs text-muted-foreground">{inspecting.latencyMs}ms</span>
                  )}
                </>
              )}
            </div>
            <button onClick={() => setInspecting(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {inspectLoading ? (
            <div className="p-6 space-y-2">
              {[...Array(3)].map((_, i) => <div key={i} className="h-3 bg-muted rounded animate-pulse" />)}
            </div>
          ) : inspecting && (
            <div className="divide-y divide-border">
              {/* Request payload */}
              <div>
                <div className="flex items-center justify-between px-5 py-2 bg-muted/20">
                  <span className="text-xs font-mono font-medium text-muted-foreground">REQUEST BODY</span>
                  <CopyBtn text={JSON.stringify(inspecting.payload, null, 2)} />
                </div>
                <pre className="px-5 py-3 text-xs font-mono leading-relaxed bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] overflow-x-auto max-h-64">
                  <code>{JSON.stringify(inspecting.payload, null, 2)}</code>
                </pre>
              </div>
              {/* Response body */}
              <div>
                <div className="flex items-center justify-between px-5 py-2 bg-muted/20">
                  <span className="text-xs font-mono font-medium text-muted-foreground">RESPONSE BODY</span>
                  {inspecting.responseBody && <CopyBtn text={inspecting.responseBody} />}
                </div>
                <pre className="px-5 py-3 text-xs font-mono leading-relaxed bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] overflow-x-auto max-h-64">
                  <code>{inspecting.responseBody ?? "(no response body)"}</code>
                </pre>
              </div>
              {/* Error */}
              {inspecting.errorMessage && (
                <div className="px-5 py-3">
                  <p className="text-xs font-medium text-[oklch(0.58_0.22_27)] mb-1">Error</p>
                  <p className="text-xs font-mono text-[oklch(0.58_0.22_27)]">{inspecting.errorMessage}</p>
                </div>
              )}
              {/* Response headers */}
              {inspecting.responseHeaders && Object.keys(inspecting.responseHeaders).length > 0 && (
                <div>
                  <div className="px-5 py-2 bg-muted/20">
                    <span className="text-xs font-mono font-medium text-muted-foreground">RESPONSE HEADERS</span>
                  </div>
                  <div className="px-5 py-3 space-y-1">
                    {Object.entries(inspecting.responseHeaders).map(([k, v]) => (
                      <div key={k} className="flex gap-3 text-xs font-mono">
                        <span className="text-muted-foreground w-48 shrink-0 truncate">{k}</span>
                        <span className="text-foreground/80 truncate">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Attempt history */}
              {(inspecting.attempts_detail ?? []).length > 0 && (
                <div>
                  <div className="px-5 py-2 bg-muted/20">
                    <span className="text-xs font-mono font-medium text-muted-foreground">ATTEMPT HISTORY ({inspecting.attempts_detail!.length})</span>
                  </div>
                  <div className="divide-y divide-border">
                    {inspecting.attempts_detail!.map((a, i) => (
                      <div key={a.id} className="px-5 py-2 flex items-center gap-4 text-xs">
                        <span className="text-muted-foreground tabular-nums">#{i + 1}</span>
                        <span className={a.statusCode && a.statusCode >= 200 && a.statusCode < 300 ? "text-[oklch(0.55_0.16_145)]" : "text-[oklch(0.58_0.22_27)]"}>
                          {a.statusCode ? `HTTP ${a.statusCode}` : "No response"}
                        </span>
                        {a.latencyMs && <span className="text-muted-foreground">{a.latencyMs}ms</span>}
                        <span className="text-muted-foreground ml-auto">{new Date(a.attemptedAt).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-5 space-y-3">
        <h3 className="text-sm font-medium">Verifying webhook signatures</h3>
        <p className="text-xs text-muted-foreground">
          Every webhook delivery includes a <code className="bg-muted rounded px-1">X-Continuum-Signature</code> header
          containing an HMAC-SHA256 of the raw request body using your webhook's secret. Verify it to ensure events are from Continuum.
        </p>
        <code className="block bg-muted rounded-md p-3 text-xs font-mono whitespace-pre overflow-x-auto">
{`// Node.js example
const crypto = require('crypto');

function verifySignature(rawBody, secret, signatureHeader) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader)
  );
}`}
        </code>
      </div>

      {/* Rotated secret one-time reveal */}
      <Dialog open={!!rotatedSecret} onOpenChange={(v) => { if (!v) setRotatedSecret(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New signing secret</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your webhook signing secret has been rotated. Copy it now — it will not be shown again.
              Update your <code className="bg-muted rounded px-1">X-Continuum-Signature</code> verification logic with the new value.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-3">
              <code className="flex-1 text-xs font-mono break-all select-all">{rotatedSecret}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(rotatedSecret ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="shrink-0 rounded p-1.5 hover:bg-background transition-colors"
                title="Copy"
              >
                {copied ? <Check className="h-4 w-4 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
              </button>
            </div>
            <p className="text-xs text-[oklch(0.58_0.22_27)]">
              The old secret is now invalid. Any webhook receiver still using it will reject signatures.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setRotatedSecret(null)} disabled={!copied}>
              {copied ? "Done" : "Copy secret first"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
