import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { StatusBadge } from "@/components/StatusBadge";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Message History — Continuum API" }] }),
  component: MessagesPage,
});

interface Message {
  id: string;
  to: string[];
  from: string;
  subject: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
}

function MessagesPage() {
  const { primaryKey } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ messages: Message[]; total: number }>("/v1/messages?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setMessages(r.data ?? r.messages ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Message History</h1>
        <p className="text-sm text-muted-foreground">All transactional emails sent through your API key.</p>
      </header>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No messages sent yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-medium">To</th>
                  <th className="px-5 py-3 font-medium">Subject</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3 font-mono text-xs">{m.to[0]}</td>
                    <td className="px-5 py-3 max-w-xs truncate">{m.subject}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {m.sentAt ? new Date(m.sentAt).toLocaleString() : new Date(m.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
