import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  Inbox, RefreshCw, MailOpen, Sparkles, ThumbsUp,
  Archive, ChevronDown, ChevronUp, User, Reply, Send,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/inbox")({
  head: () => ({ meta: [{ title: "Unified Inbox — Continuum" }] }),
  component: InboxPage,
});

interface Reply {
  id: string;
  fromEmail: string;
  subject: string | null;
  bodySnippet: string | null;
  receivedAt: string;
  enrollmentId: string | null;
  mailboxId: string;
  isRead: boolean;
  status: string;
  enrollment?: {
    sequenceId: string;
    email: string;
    status: string;
    sequence?: { id: string; name: string };
  } | null;
}

interface ClassifyResult {
  category: string;
  confidence: number;
  suggested_action: string;
}

const CATEGORY_STYLES: Record<string, string> = {
  interested:      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  meeting_request: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  not_interested:  "bg-red-500/10 text-red-600 dark:text-red-400",
  unsubscribe:     "bg-red-500/10 text-red-600 dark:text-red-400",
  out_of_office:   "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  referral:        "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  question:        "bg-muted text-muted-foreground",
  bounced:         "bg-red-500/10 text-red-600 dark:text-red-400",
};

const CATEGORY_EMOJI: Record<string, string> = {
  interested:      "🔥",
  meeting_request: "📅",
  not_interested:  "✗",
  unsubscribe:     "🚫",
  out_of_office:   "🏖",
  referral:        "👥",
  question:        "❓",
};

const ACTION_LABEL: Record<string, string> = {
  reply:       "Reply now",
  close:       "Close / remove",
  pause:       "Pause sequence",
  escalate:    "Escalate to team",
  unsubscribe: "Unsubscribe",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-muted text-muted-foreground",
  interested: "bg-muted text-[oklch(0.55_0.16_145)]",
  not_interested: "bg-muted text-[oklch(0.58_0.22_27)]",
  archived: "bg-muted text-muted-foreground",
};

function InboxPage() {
  const { primaryKey } = useAuth();
  const navigate = useNavigate();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [classifyResults, setClassifyResults] = useState<Record<string, ClassifyResult>>({});
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [autoClassifyQueue, setAutoClassifyQueue] = useState<Reply[]>([]);
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    api.withKey
      .get<{ data?: Reply[]; replies?: Reply[]; total: number }>("/v1/inbox?page=1&limit=100", primaryKey.keyRaw)
      .then((r) => {
        const loaded = r.data ?? r.replies ?? [];
        setReplies(loaded);
        // Queue new/unread replies for auto-classification (up to 10 to avoid hammering)
        setAutoClassifyQueue(loaded.filter(x => x.status === "new" || !x.isRead).slice(0, 10));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  // Auto-classify queued replies sequentially in the background
  useEffect(() => {
    if (!primaryKey?.keyRaw || autoClassifyQueue.length === 0) return;
    const [next, ...rest] = autoClassifyQueue;
    if (classifyResults[next.id]) { setAutoClassifyQueue(rest); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("https://api.continuumapi.com/v1/ai/classify-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
          body: JSON.stringify({ subject: next.subject ?? undefined, body: next.bodySnippet ?? next.subject ?? "reply" }),
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null) as ClassifyResult | null;
        if (data && !cancelled) setClassifyResults((prev) => ({ ...prev, [next.id]: data }));
      } catch { /* silent — auto-classify is best-effort */ }
      if (!cancelled) setAutoClassifyQueue(rest);
    })();
    return () => { cancelled = true; };
  }, [autoClassifyQueue, primaryKey]);

  const classify = async (r: Reply) => {
    if (!primaryKey?.keyRaw || classifyingId) return;
    setClassifyingId(r.id);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/ai/classify-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({
          subject: r.subject ?? undefined,
          body: r.bodySnippet ?? r.subject ?? "reply",
        }),
      });
      const data = await res.json().catch(() => null) as ClassifyResult | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      setClassifyResults((prev) => ({ ...prev, [r.id]: data as ClassifyResult }));
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setClassifyingId(null); }
  };

  const updateStatus = async (r: Reply, status: string) => {
    if (!primaryKey?.keyRaw) return;
    setUpdatingId(r.id);
    try {
      await api.withKey.patch(`/v1/inbox/${r.id}`, { status }, primaryKey.keyRaw);
      setReplies(prev => prev.map(x => x.id === r.id ? { ...x, status } : x));
      toast.success(status === "interested" ? "Marked as interested." : "Archived.");
    } catch { toast.error("Update failed."); }
    finally { setUpdatingId(null); }
  };

  const markLeadInterested = async (r: Reply) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.patch(`/v1/inbox/${r.id}`, {
        status: "interested",
        lead_status: "interested",
      }, primaryKey.keyRaw);
      setReplies(prev => prev.map(x => x.id === r.id ? { ...x, status: "interested" } : x));
      toast.success("Lead marked as interested.");
    } catch { toast.error("Update failed."); }
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleReply = (r: Reply) => {
    setReplyOpenId(prev => {
      if (prev === r.id) return null;
      if (r.bodySnippet) setExpanded(exp => new Set(exp).add(r.id)); // show what you're replying to
      return r.id;
    });
  };

  const sendReply = async (r: Reply) => {
    if (!primaryKey?.keyRaw) return;
    const body = (replyDrafts[r.id] ?? "").trim();
    if (!body) return;
    setSendingReplyId(r.id);
    try {
      const res = await api.withKey.post<{ sent: boolean; error?: string }>(
        `/v1/inbox/${r.id}/reply`,
        { body },
        primaryKey.keyRaw,
      );
      if (!res.sent) throw new Error(res.error ?? "Send failed");
      toast.success(`Reply sent to ${r.fromEmail}.`);
      setReplyDrafts(prev => { const next = { ...prev }; delete next[r.id]; return next; });
      setReplyOpenId(null);
      setReplies(prev => prev.map(x => x.id === r.id ? { ...x, isRead: true } : x));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't send reply.");
    } finally {
      setSendingReplyId(null);
    }
  };

  const activeReplies = replies.filter(r => r.status !== "archived");
  const archivedReplies = replies.filter(r => r.status === "archived");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Unified Inbox</h1>
          <p className="text-sm text-muted-foreground">All replies across every mailbox and sequence in one place.</p>
        </header>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-start gap-4">
              <div className="flex-1 space-y-2">
                <div className="h-3 w-40 bg-muted rounded animate-pulse" />
                <div className="h-3 w-56 bg-muted rounded animate-pulse" />
              </div>
              <div className="h-5 w-20 bg-muted rounded-full animate-pulse mt-0.5" />
            </div>
          ))}
        </div>
      ) : replies.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No replies yet.</p>
          <p className="text-xs text-muted-foreground">When prospects reply to your sequences, they appear here — across all connected mailboxes.</p>
        </div>
      ) : (
        <>
          {activeReplies.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="divide-y divide-border">
                {activeReplies.map((r) => {
                  const classification = classifyResults[r.id];
                  const isExpanded = expanded.has(r.id);
                  const seqName = r.enrollment?.sequence?.name;
                  return (
                    <div key={r.id}>
                    <div className="flex items-start gap-4 p-4 hover:bg-muted/20 transition-colors">
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                        <MailOpen className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            className="font-medium text-sm hover:underline"
                            onClick={() => navigate({ to: "/dashboard/leads", search: { q: r.fromEmail } as never })}
                          >
                            {r.fromEmail}
                          </button>
                          {seqName && (
                            <span className="text-xs bg-muted px-1.5 py-0.5 rounded">{seqName}</span>
                          )}
                          {r.status !== "new" && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLES[r.status] ?? "bg-muted text-muted-foreground"}`}>
                              {r.status.replace(/_/g, " ")}
                            </span>
                          )}
                          {classification ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${CATEGORY_STYLES[classification.category] ?? "bg-muted text-muted-foreground"}`}>
                              {CATEGORY_EMOJI[classification.category] ?? "🤖"} {classification.category.replace(/_/g, " ")}
                            </span>
                          ) : autoClassifyQueue.find(q => q.id === r.id) ? (
                            <span className="text-xs text-muted-foreground animate-pulse">Classifying…</span>
                          ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">{r.subject ?? "(no subject)"}</p>
                        {r.bodySnippet && isExpanded && (
                          <p className="text-xs text-muted-foreground mt-1.5 p-2 bg-muted/30 rounded whitespace-pre-wrap line-clamp-6">
                            {r.bodySnippet}
                          </p>
                        )}
                        {classification?.suggested_action && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            <span className="font-medium text-foreground/70">Next: </span>
                            {ACTION_LABEL[classification.suggested_action] ?? classification.suggested_action}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                        <span className="text-xs text-muted-foreground">{new Date(r.receivedAt).toLocaleString()}</span>
                        {r.bodySnippet && (
                          <button
                            className="p-1 rounded hover:bg-muted text-muted-foreground"
                            onClick={() => toggleExpand(r.id)}
                            title={isExpanded ? "Collapse" : "Expand"}
                          >
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <button
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          onClick={() => navigate({ to: "/dashboard/leads/$id", params: { id: r.fromEmail } })}
                          title="View lead profile"
                        >
                          <User className="h-3.5 w-3.5" />
                        </button>
                        <Button
                          variant={replyOpenId === r.id ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          onClick={() => toggleReply(r)}
                          title="Reply"
                        >
                          <Reply className="h-3 w-3" />
                          Reply
                        </Button>
                        {r.status !== "interested" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            disabled={updatingId === r.id}
                            onClick={() => markLeadInterested(r)}
                            title="Mark interested"
                          >
                            <ThumbsUp className="h-3 w-3" />
                            Interested
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-xs text-muted-foreground"
                          disabled={updatingId === r.id}
                          onClick={() => updateStatus(r, "archived")}
                          title="Archive"
                        >
                          <Archive className="h-3 w-3" />
                          Archive
                        </Button>
                        {!classification && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            disabled={classifyingId === r.id}
                            onClick={() => classify(r)}
                          >
                            <Sparkles className="h-3 w-3" />
                            {classifyingId === r.id ? "…" : "Classify"}
                          </Button>
                        )}
                      </div>
                    </div>
                    {replyOpenId === r.id && (
                      <div className="px-4 pb-4 pl-16">
                        <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
                          <textarea
                            autoFocus
                            rows={4}
                            placeholder={`Reply to ${r.fromEmail}…`}
                            className="w-full text-sm bg-background rounded border border-border p-2 resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                            value={replyDrafts[r.id] ?? ""}
                            onChange={(e) => setReplyDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                            disabled={sendingReplyId === r.id}
                          />
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-muted-foreground">
                              Sends from the mailbox that received this — {r.mailboxId ? "same thread." : "no mailbox on file."}
                            </span>
                            <div className="flex items-center gap-2">
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setReplyOpenId(null)}>
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 gap-1.5 text-xs"
                                disabled={sendingReplyId === r.id || !(replyDrafts[r.id] ?? "").trim()}
                                onClick={() => sendReply(r)}
                              >
                                <Send className="h-3 w-3" />
                                {sendingReplyId === r.id ? "Sending…" : "Send"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {archivedReplies.length > 0 && (
            <details className="group">
              <summary className="text-xs text-muted-foreground cursor-pointer select-none flex items-center gap-1.5 py-1">
                <ChevronDown className="h-3 w-3 group-open:rotate-180 transition-transform" />
                {archivedReplies.length} archived
              </summary>
              <div className="mt-2 rounded-lg border border-border bg-card/50 overflow-hidden">
                <div className="divide-y divide-border">
                  {archivedReplies.map((r) => (
                    <div key={r.id} className="flex items-center gap-4 px-4 py-3 opacity-60">
                      <MailOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium">{r.fromEmail}</span>
                        <span className="text-sm text-muted-foreground ml-2">{r.subject ?? "(no subject)"}</span>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => updateStatus(r, "new")}>
                        Unarchive
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
