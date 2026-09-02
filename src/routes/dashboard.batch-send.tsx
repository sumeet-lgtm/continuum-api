import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Send, CheckCircle2, XCircle, Layers } from "lucide-react";

export const Route = createFileRoute("/dashboard/batch-send")({
  head: () => ({ meta: [{ title: "Batch Send — Continuum API" }] }),
  component: BatchSendPage,
});

interface BatchResult {
  id: string;
  status: string;
  error?: string;
  to: string;
}

function BatchSendPage() {
  const { primaryKey } = useAuth();
  const [form, setForm] = useState({
    recipients: "",
    subject: "",
    htmlBody: "",
    textBody: "",
    replyTo: "",
  });
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [summary, setSummary] = useState<{ sent: number; total: number } | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const parsedEmails = form.recipients
    .split(/[\n,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@") && e.includes("."));

  const unique = [...new Set(parsedEmails)];

  const send = async () => {
    if (!primaryKey?.keyRaw) return;
    if (unique.length === 0) { toast.error("Enter at least one valid email address"); return; }
    if (!form.subject.trim()) { toast.error("Subject is required"); return; }
    if (!form.htmlBody.trim() && !form.textBody.trim()) { toast.error("HTML or text body is required"); return; }
    if (unique.length > 100) { toast.error("Maximum 100 recipients per batch"); return; }

    setSending(true);
    setResults(null);
    setSummary(null);

    const messages = unique.map((to) => ({
      to,
      subject: form.subject.trim(),
      ...(form.htmlBody.trim() ? { html_body: form.htmlBody.trim() } : {}),
      ...(form.textBody.trim() ? { text_body: form.textBody.trim() } : {}),
      ...(form.replyTo.trim() ? { reply_to: form.replyTo.trim() } : {}),
    }));

    try {
      const res = await fetch("https://api.continuumapi.com/v1/send/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ messages }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);

      const typed = data as { results: Array<{ id: string; status: string; error?: string }>; sent: number; total: number };
      const withTo = (typed.results ?? []).map((r, i) => ({ ...r, to: unique[i] ?? "" }));
      setResults(withTo);
      setSummary({ sent: typed.sent, total: typed.total });
      toast.success(`${typed.sent} of ${typed.total} sent`);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Batch Send</h1>
        <p className="text-sm text-muted-foreground">Send the same email to up to 100 recipients in one API call.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form */}
        <div className="space-y-5 rounded-lg border border-border bg-card p-6">
          <div className="space-y-1.5">
            <Label>Recipients <span className="text-muted-foreground font-normal">(one per line, or comma-separated)</span></Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={"alice@company.com\nbob@company.com\ncharlie@company.com"}
              value={form.recipients}
              onChange={set("recipients")}
            />
            {unique.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {unique.length} unique address{unique.length !== 1 ? "es" : ""}
                {unique.length > 100 && <span className="text-destructive font-medium"> — max 100 per batch</span>}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Subject *</Label>
            <Input placeholder="Your subject line" value={form.subject} onChange={set("subject")} />
          </div>

          <div className="space-y-1.5">
            <Label>HTML body</Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={"<p>Hi there,</p>\n<p>Here's your update.</p>"}
              value={form.htmlBody}
              onChange={set("htmlBody")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Plain text body <span className="text-muted-foreground font-normal">(optional fallback)</span></Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Hi there, here's your update."
              value={form.textBody}
              onChange={set("textBody")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Reply-To <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="email" placeholder="replies@yourapp.com" value={form.replyTo} onChange={set("replyTo")} />
          </div>

          <Button
            onClick={send}
            disabled={sending || unique.length === 0 || unique.length > 100}
            className="w-full gap-1.5"
          >
            <Send className="h-4 w-4" />
            {sending ? `Sending to ${unique.length}…` : `Send to ${unique.length || "—"} recipients`}
          </Button>
        </div>

        {/* Results */}
        <div className="space-y-4">
          {summary && (
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3 mb-4">
                <Layers className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-semibold">{summary.sent} sent · {summary.total - summary.sent} failed</p>
                  <p className="text-xs text-muted-foreground">{summary.total} total recipients</p>
                </div>
              </div>

              {results && results.length > 0 && (
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 text-muted-foreground border-b border-border">
                        <th className="px-3 py-2 text-left font-medium">Recipient</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-left font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5 font-mono">{r.to}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1">
                              {r.status === "sent" || r.status === "delivered"
                                ? <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" />
                                : <XCircle className="h-3.5 w-3.5 text-[oklch(0.58_0.22_27)]" />}
                              <StatusBadge status={r.status} />
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground max-w-[160px] truncate">
                            {r.error ?? (r.id ? <span className="font-mono text-[10px]">{r.id.slice(0, 8)}…</span> : "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {!results && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Layers className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Results will appear here after sending.</p>
              <p className="text-xs text-muted-foreground mt-1">Each recipient gets a separate tracked message with its own ID.</p>
            </div>
          )}

          <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">API equivalent</p>
            <pre className="text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
{`POST /v1/send/batch
{
  "messages": [
    { "to": "alice@co.com", "subject": "…", "html_body": "…" },
    { "to": "bob@co.com",   "subject": "…", "html_body": "…" }
  ]
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
