import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Eye,
  MousePointerClick, Mail, AlertTriangle, Clock, X, Ban, Pencil, Download,
} from "lucide-react";
import { Label } from "@/components/ui/label";

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
    case "sent": return <Mail className="h-3.5 w-3.5 text-foreground" />;
    case "delivered": return <CheckCircle2 className="h-3.5 w-3.5 text-foreground" />;
    case "bounced": return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "complained": return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "open": return <Eye className="h-3.5 w-3.5 text-muted-foreground" />;
    case "click": return <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" />;
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

  // Edit modal
  const [editTarget, setEditTarget] = useState<Message | null>(null);
  const [editForm, setEditForm] = useState({ subject: "", scheduled_at: "", html_body: "", text_body: "" });
  const [saving, setSaving] = useState(false);

  // CSV export
  const [exporting, setExporting] = useState(false);

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

  const openEdit = (m: Message) => {
    setEditForm({
      subject: m.subject,
      scheduled_at: "",
      html_body: "",
      text_body: "",
    });
    setEditTarget(m);
  };

  const saveEdit = async () => {
    if (!primaryKey?.keyRaw || !editTarget) return;
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      if (editForm.subject.trim() && editForm.subject !== editTarget.subject) payload.subject = editForm.subject.trim();
      if (editForm.scheduled_at.trim()) payload.scheduled_at = new Date(editForm.scheduled_at).toISOString();
      if (editForm.html_body.trim()) payload.html_body = editForm.html_body.trim();
      if (editForm.text_body.trim()) payload.text_body = editForm.text_body.trim();
      if (Object.keys(payload).length === 0) { setEditTarget(null); return; }
      const res = await fetch(`https://api.continuumapi.com/v1/messages/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      toast.success("Scheduled email updated");
      setMessages((m) => m.map((x) => x.id === editTarget.id ? { ...x, subject: payload.subject ?? x.subject } : x));
      setEditTarget(null);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const exportCsv = async () => {
    if (!primaryKey?.keyRaw) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: "1000" });
      if (statusFilter) params.set("status", statusFilter);
      if (toFilter) params.set("to", toFilter);
      const res = await fetch(`https://api.continuumapi.com/v1/messages?${params}`, {
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      const data = await res.json().catch(() => null) as { data?: Message[] };
      const rows = data?.data ?? [];
      const lines = [
        "id,to,from,subject,status,created_at,sent_at",
        ...rows.map((r) => [
          r.id,
          `"${toArray(r.to).join("; ")}"`,
          `"${r.from}"`,
          `"${r.subject.replace(/"/g, '""')}"`,
          r.status,
          new Date(r.createdAt).toISOString(),
          r.sentAt ? new Date(r.sentAt).toISOString() : "",
        ].join(",")),
      ];
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "messages.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error("Export failed"); }
    finally { setExporting(false); }
  };

  const applyToFilter = () => { setToFilter(toInput.trim()); setPage(1); };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Message History</h1>
          <p className="text-sm text-muted-foreground">All transactional emails sent through your API key.</p>
        </header>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground tabular-nums">{total.toLocaleString()} total</span>
          <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={exportCsv} disabled={exporting}>
            <Download className="h-3.5 w-3.5" />{exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Edit scheduled email modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditTarget(null)}>
          <div className="bg-card border border-border rounded-xl shadow-lg w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Edit Scheduled Email</h2>
              <button onClick={() => setEditTarget(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Subject</Label>
                <Input
                  value={editForm.subject}
                  onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Reschedule to</Label>
                <Input
                  type="datetime-local"
                  value={editForm.scheduled_at}
                  onChange={(e) => setEditForm((f) => ({ ...f, scheduled_at: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">HTML body <span className="text-muted-foreground font-normal">(leave blank to keep existing)</span></Label>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="<p>Updated content…</p>"
                  value={editForm.html_body}
                  onChange={(e) => setEditForm((f) => ({ ...f, html_body: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button size="sm" onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
            </div>
          </div>
        </div>
      )}

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
              {[...Array(8)].map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-5 py-3"><Skeleton className="h-3 w-3" /></td>
                  <td className="px-5 py-3"><Skeleton className="h-3 w-40" /></td>
                  <td className="px-5 py-3"><Skeleton className="h-3 w-56" /></td>
                  <td className="px-5 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                  <td className="px-5 py-3"><Skeleton className="h-3 w-28" /></td>
                </tr>
              ))}
            </tbody>
          </table>
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
                          <div className="flex gap-6">
                            <div className="space-y-2 flex-1">
                              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-3 w-full" />)}
                            </div>
                            <div className="space-y-2 flex-1">
                              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-3 w-full" />)}
                            </div>
                          </div>
                        ) : detail ? (
                          <DetailPanel
                            detail={detail}
                            onCancel={() => cancel(detail.id)}
                            onEdit={() => openEdit(messages.find((x) => x.id === detail.id) ?? detail)}
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

function DetailPanel({ detail, onCancel, onEdit, cancelling }: { detail: MessageDetail; onCancel: () => void; onEdit: () => void; cancelling: boolean }) {
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
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="gap-1.5"
              onClick={onCancel}
              disabled={cancelling}
            >
              <Ban className="h-3.5 w-3.5" />
              {cancelling ? "Cancelling…" : "Cancel Send"}
            </Button>
          </div>
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
