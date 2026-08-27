import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Inbox, RefreshCw, MailOpen, Archive } from "lucide-react";

export const Route = createFileRoute("/dashboard/inbox")({
  head: () => ({ meta: [{ title: "Unified Inbox — Continuum API" }] }),
  component: InboxPage,
});

interface Reply {
  id: string;
  fromEmail: string;
  subject: string | null;
  receivedAt: string;
  sequenceEnrollmentId: string | null;
  mailboxId: string;
}

function InboxPage() {
  const { primaryKey } = useAuth();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    api.withKey
      .get<{ replies: Reply[]; total: number }>("/v1/inbox?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setReplies(r.replies ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Unified Inbox</h1>
          <p className="text-sm text-muted-foreground">All replies across every mailbox and sequence in one place.</p>
        </header>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : replies.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No replies yet.</p>
          <p className="text-xs text-muted-foreground">When prospects reply to your sequences, they appear here — across all connected mailboxes.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border">
            {replies.map((r) => (
              <div key={r.id} className="flex items-start gap-4 p-4 hover:bg-muted/20 transition-colors">
                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  <MailOpen className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{r.fromEmail}</span>
                    {r.sequenceEnrollmentId && (
                      <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Sequence reply</span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">{r.subject ?? "(no subject)"}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">{new Date(r.receivedAt).toLocaleString()}</span>
                  <Button variant="ghost" size="icon" className="h-7 w-7"><Archive className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
