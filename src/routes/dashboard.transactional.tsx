import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/dashboard/transactional")({
  head: () => ({ meta: [{ title: "Send Email — Continuum API" }] }),
  component: TransactionalPage,
});

function TransactionalPage() {
  const { primaryKey } = useAuth();
  const [form, setForm] = useState({
    from: "",
    to: "",
    subject: "",
    html: "",
    text: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ id: string } | null>(null);

  const send = async () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    try {
      const res = await api.withKey.post<{ id: string }>(
        "/v1/send",
        {
          from: form.from,
          to: [form.to],
          subject: form.subject,
          html_body: form.html || undefined,
          text_body: form.text || undefined,
        },
        primaryKey.keyRaw,
      );
      setResult(res);
      toast.success("Email sent", { description: `Message ID: ${res.id}` });
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Send Transactional Email</h1>
        <p className="text-sm text-muted-foreground">
          Send a single email via the Continuum API. Uses your primary API key.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>From</Label>
            <Input placeholder="noreply@yourapp.com" value={form.from} onChange={set("from")} />
          </div>
          <div className="space-y-1.5">
            <Label>To</Label>
            <Input placeholder="recipient@example.com" value={form.to} onChange={set("to")} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input placeholder="Your subject line" value={form.subject} onChange={set("subject")} />
        </div>
        <div className="space-y-1.5">
          <Label>HTML Body</Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="<p>Hello {{first_name}},</p>"
            value={form.html}
            onChange={set("html")}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Plain Text (optional)</Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Plain text fallback"
            value={form.text}
            onChange={set("text")}
          />
        </div>
        <Button onClick={send} disabled={loading || !primaryKey}>
          {loading ? "Sending…" : "Send Email"}
        </Button>
        {result && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono text-muted-foreground">
            ✓ Sent — message ID: {result.id}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 max-w-2xl">
        <h2 className="text-sm font-semibold mb-3">API Reference</h2>
        <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto text-muted-foreground whitespace-pre">{`POST https://api.continuumapi.com/v1/send
X-API-Key: ${primaryKey?.keyRaw ?? "<your-api-key>"}

{
  "from": "noreply@yourapp.com",
  "to": ["recipient@example.com"],
  "subject": "Your subject",
  "html_body": "<p>Hello!</p>",
  "text_body": "Hello!",
  "template_id": "tmpl_xxx",     // optional
  "scheduled_at": "2026-09-01T09:00:00Z"  // optional
}`}</pre>
      </div>
    </div>
  );
}
