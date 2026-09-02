import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Inbox, RefreshCw, MailOpen, Sparkles } from "lucide-react";

export const Route = createFileRoute("/dashboard/inbox")({
  head: () => ({ meta: [{ title: "Unified Inbox — Continuum API" }] }),
  component: InboxPage,
});

interface Reply {
  id: string;
  fromEmail: string;
  subject: string | null;
  receivedAt: string;
  enrollmentId: string | null;
  mailboxId: string;
}

interface ClassifyResult {
  category: string;
  confidence: number;
  suggested_action: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  interested: "bg-muted text-[oklch(0.55_0.16_145)]",
  not_interested: "bg-muted text-[oklch(0.58_0.22_27)]",
  out_of_office: "bg-muted text-muted-foreground",
  question: "bg-muted text-muted-foreground",
  unsubscribe: "bg-muted text-[oklch(0.58_0.22_27)]",
  bounced: "bg-muted text-[oklch(0.58_0.22_27)]",
};

function InboxPage() {
  const { primaryKey } = useAuth();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [classifyResults, setClassifyResults] = useState<Record<string, ClassifyResult>>({});
  const [classifyingId, setClassifyingId] = useState<string | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    api.withKey
      .get<{ data?: Reply[]; replies?: Reply[]; total: number }>("/v1/inbox?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setReplies(r.data ?? r.replies ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const classify = async (r: Reply) => {
    if (!primaryKey?.keyRaw || classifyingId) return;
    setClassifyingId(r.id);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/ai/classify-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ subject: r.subject ?? undefined, body: r.subject ?? "reply" }),
      });
      const data = await res.json().catch(() => null) as ClassifyResult | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      setClassifyResults((prev) => ({ ...prev, [r.id]: data as ClassifyResult }));
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setClassifyingId(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Unified Inbox</h1>
          <p className="text-sm text-muted-foreground">All replies across every mailbox and sequence in one place.</p>
        </header>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
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
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border">
            {replies.map((r) => {
              const classification = classifyResults[r.id];
              return (
                <div key={r.id} className="flex items-start gap-4 p-4 hover:bg-muted/20 transition-colors">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                    <MailOpen className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{r.fromEmail}</span>
                      {r.enrollmentId && (
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Sequence reply</span>
                      )}
                      {classification && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${CATEGORY_COLORS[classification.category] ?? "bg-muted text-muted-foreground"}`}>
                          {classification.category.replace(/_/g, " ")}
                          {" "}· {Math.round(classification.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">{r.subject ?? "(no subject)"}</p>
                    {classification?.suggested_action && (
                      <p className="text-xs text-muted-foreground mt-0.5 italic">{classification.suggested_action}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">{new Date(r.receivedAt).toLocaleString()}</span>
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
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
