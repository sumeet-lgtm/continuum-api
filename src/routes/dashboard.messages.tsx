import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Eye,
  MousePointerClick, Mail, AlertTriangle, Clock, X, Ban,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Message History — Continuum API" }] }),
  component: MessagesPage,
});

interface Message {
  id: string;
  to: string | string[];
  from: string;
  subject: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
  tags?: Record<string, string>;
}

interface SendEvent {
  id: string;
  type: string;
  occurredAt: string;
}

interface TrackingEvent {
  id: string;
  type: string;
  linkUrl?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  occurredAt: string;
}

interface MessageDetail extends Message {
  events: SendEvent[];
  trackingEvents: TrackingEvent[];
  scheduledAt?: string | null;
}

const STATUS_OPTIONS = ["", "sent", "delivered", "bounced", "complained", "scheduled", "cancelled", "failed"];

function eventIcon(type: string) {
  switch (type) {
    case "sent": return <Mail className="h-3.5 w-3.5 text-blue-500" />;
    case "delivered": return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "bounced": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "complained": return <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "open": return <Eye className="h-3.5 w-3.5 text-purple-500" />;
    case "click": return <MousePointerClick className="h-3.5 w-3.5 text-indigo-500" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function MessagesPage() {
  const { primaryKey } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Filters
  const [statusFilter, setStatusFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [toInput, setToInput] = useState("");

  // Detail panel
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const LIMIT = 50;

  const load = useCallback(() => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (statusFilter) params.set("status", statusFilter);
    if (toFilter) params.set("to", toFilter);
    fetch(`https://api.continuumapi.com/v1/messages?${params}`, {
      headers: { "X-API-Key": primaryKey.keyRaw! },
    })
      .then((r) => r.json())
      .then((r) => {
        const data = r as { data?: Message[]; messages?: Message[]; total?: number };
        setMessages(data.data ?? data.messages ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey, page, statusFilter, toFilter]);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/messages/${id}`, {
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      const data = await res.json().catch(() => null);
      setDetail(data as MessageDetail);
    } catch { /* ignore */ }
    finally { setDetailLoading(false); }
  };

  const cancel = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    setCancelling(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/messages/${id}/cancel`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      toast.success("Scheduled send cancelled");
      setMessages((m) => m.map((x) => x.id === id ? { ...x, status: "cancelled" } : x));
      if (detail?.id === id) setDetail((d) => d ? { ...d, status: "cancelled" } : d);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setCancelling(false); }
  };

  const applyToFilter = () => { setToFilter(toInput.trim()); setPage(1); };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Message History</h1>
          <p className="text-sm text-muted-foreground">All transactional emails sent through your API key.</p>
        </header>
        <span className="text-sm text-muted-foreground tabular-nums">{total.toLocaleString()} total</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <div className="flex gap-1.5">
          <Input
            placeholder="Filter by recipient email"
            className="h-8 text-sm w-64"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyToFilter()}
          />
          {toFilter ? (
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setToFilter(""); setToInput(""); setPage(1); }}>
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={applyToFilter}>Search</Button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No messages found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium w-6"></th>
                <th className="px-5 py-3 font-medium">To</th>
                <th className="px-5 py-3 font-medium">Subject</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => {
                const toList = toArray(m.to);
                const isExpanded = expandedId === m.id;
                return [
                  <tr
                    key={m.id}
                    className="border-b border-border hover:bg-muted/20 cursor-pointer"
                    onClick={() => loadDetail(m.id)}
                  >
                    <td className="px-5 py-3">
                      {isExpanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">{toList[0]}{toList.length > 1 && <span className="text-muted-foreground"> +{toList.length - 1}</span>}</td>
                    <td className="px-5 py-3 max-w-xs truncate">{m.subject}</td>
                    <td className="px-5 py-3"><StatusBadge status={m.status} /></td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">
                      {m.sentAt ? new Date(m.sentAt).toLocaleString() : new Date(m.createdAt).toLocaleString()}
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${m.id}-detail`} className="border-b border-border bg-muted/10">
                      <td colSpan={5} className="px-8 py-4">
                        {detailLoading ? (
                          <p className="text-xs text-muted-foreground">Loading…</p>
                        ) : detail ? (
                          <DetailPanel
                            detail={detail}
                            onCancel={() => cancel(detail.id)}
                            cancelling={cancelling}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailPanel({ detail, onCancel, cancelling }: { detail: MessageDetail; onCancel: () => void; cancelling: boolean }) {
  const allEvents = [
    ...detail.events.map((e) => ({ ...e, source: "delivery" as const })),
    ...detail.trackingEvents.map((e) => ({ ...e, source: "tracking" as const })),
  ].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  const tags = detail.tags ?? {};
  const hasTags = Object.keys(tags).length > 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: metadata */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Details</p>
        <dl className="space-y-1.5 text-sm">
          <Row label="From" value={detail.from} mono />
          <Row label="To" value={toArray(detail.to).join(", ")} mono />
          <Row label="Subject" value={detail.subject} />
          <Row label="Status" value={detail.status} />
          {detail.scheduledAt && <Row label="Scheduled" value={new Date(detail.scheduledAt).toLocaleString()} />}
          <Row label="Created" value={new Date(detail.createdAt).toLocaleString()} />
          {detail.sentAt && <Row label="Sent" value={new Date(detail.sentAt).toLocaleString()} />}
        </dl>
        {hasTags && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(tags).map(([k, v]) => (
                <span key={k} className="rounded bg-muted px-2 py-0.5 text-xs font-mono">{k}={v}</span>
              ))}
            </div>
          </div>
        )}
        {detail.status === "scheduled" && (
          <Button
            size="sm"
            variant="destructive"
            className="gap-1.5"
            onClick={onCancel}
            disabled={cancelling}
          >
            <Ban className="h-3.5 w-3.5" />
            {cancelling ? "Cancelling…" : "Cancel Scheduled Send"}
          </Button>
        )}
      </div>

      {/* Right: event timeline */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Event Timeline</p>
        {allEvents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events yet.</p>
        ) : (
          <div className="space-y-2">
            {allEvents.map((ev, i) => (
              <div key={ev.id + i} className="flex items-start gap-2.5">
                <div className="mt-0.5 shrink-0">{eventIcon(ev.type)}</div>
                <div className="min-w-0">
                  <p className="text-sm capitalize">{ev.type}</p>
                  {"linkUrl" in ev && ev.linkUrl && (
                    <p className="text-xs text-muted-foreground truncate">{ev.linkUrl}</p>
                  )}
                  {"ip" in ev && ev.ip && (
                    <p className="text-xs text-muted-foreground">{ev.ip}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{new Date(ev.occurredAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function toArray(val: string | string[]): string[] {
  return Array.isArray(val) ? val : [val];
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="text-muted-foreground w-16 shrink-0">{label}</dt>
      <dd className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
