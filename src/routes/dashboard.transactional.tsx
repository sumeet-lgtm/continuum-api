import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronUp } from "lucide-react";

export const Route = createFileRoute("/dashboard/transactional")({
  head: () => ({ meta: [{ title: "Send Email — Continuum API" }] }),
  component: TransactionalPage,
});

interface Template { id: string; name: string; subject: string; }

function TransactionalPage() {
  const { primaryKey } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState({
    from: "",
    to: "",
    cc: "",
    bcc: "",
    reply_to: "",
    subject: "",
    html: "",
    text: "",
    template_id: "",
    scheduled_at: "",
    idempotency_key: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ templates: Template[] }>("/v1/templates", primaryKey.keyRaw)
      .then((r) => setTemplates(r.templates ?? []))
      .catch(() => {});
  }, [primaryKey]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const send = async () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        from: form.from,
        to: form.to.trim(),
        subject: form.subject || undefined,
        html_body: form.html || undefined,
        text_body: form.text || undefined,
        template_id: form.template_id || undefined,
        scheduled_at: form.scheduled_at || undefined,
        idempotency_key: form.idempotency_key || undefined,
      };
      if (form.cc) body.cc = form.cc.split(",").map((s) => s.trim()).filter(Boolean);
      if (form.bcc) body.bcc = form.bcc.split(",").map((s) => s.trim()).filter(Boolean);
      if (form.reply_to) body.reply_to = form.reply_to;

      const res = await api.withKey.post<{ id: string }>("/v1/send", body, primaryKey.keyRaw);
      setResult(res);
      if (form.scheduled_at) {
        toast.success("Email scheduled", { description: `Message ID: ${res.id}` });
      } else {
        toast.success("Email sent", { description: `Message ID: ${res.id}` });
      }
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Send Transactional Email</h1>
        <p className="text-sm text-muted-foreground">
          Send a single email via the API. Supports templates, CC/BCC, reply-to, and scheduled delivery.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>From *</Label>
            <Input placeholder="noreply@yourapp.com" value={form.from} onChange={set("from")} />
          </div>
          <div className="space-y-1.5">
            <Label>To *</Label>
            <Input placeholder="user@example.com" value={form.to} onChange={set("to")} />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input placeholder="Your subject line (or set via template)" value={form.subject} onChange={set("subject")} />
        </div>

        {templates.length > 0 && (
          <div className="space-y-1.5">
            <Label>Template (optional)</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.template_id}
              onChange={set("template_id")}
            >
              <option value="">— None (use HTML below) —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

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

        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Advanced options
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-1 border-t border-border">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>CC (comma-separated)</Label>
                <Input placeholder="cc@example.com" value={form.cc} onChange={set("cc")} />
              </div>
              <div className="space-y-1.5">
                <Label>BCC (comma-separated)</Label>
                <Input placeholder="bcc@example.com" value={form.bcc} onChange={set("bcc")} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Reply-To</Label>
                <Input placeholder="replies@yourapp.com" value={form.reply_to} onChange={set("reply_to")} />
              </div>
              <div className="space-y-1.5">
                <Label>Schedule (ISO 8601)</Label>
                <Input type="datetime-local" value={form.scheduled_at} onChange={set("scheduled_at")} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Idempotency Key</Label>
              <Input placeholder="e.g. welcome-user-123 (prevents duplicate sends)" value={form.idempotency_key} onChange={set("idempotency_key")} />
            </div>
          </div>
        )}

        <Button onClick={send} disabled={loading || !primaryKey || !form.from || !form.to}>
          {loading ? "Sending…" : form.scheduled_at ? "Schedule Email" : "Send Email"}
        </Button>

        {result && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono text-muted-foreground">
            ✓ {form.scheduled_at ? "Scheduled" : "Sent"} — message ID: {result.id}
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
  "cc": ["cc@example.com"],          // optional
  "bcc": ["bcc@example.com"],        // optional
  "reply_to": "support@yourapp.com", // optional
  "subject": "Your subject",
  "html_body": "<p>Hello {{first_name}}!</p>",
  "text_body": "Hello!",             // optional
  "template_id": "tmpl_xxx",        // optional — overrides html_body/subject
  "scheduled_at": "2026-09-01T09:00:00Z",  // optional
  "idempotency_key": "welcome-user-123"    // optional
}`}</pre>
      </div>
    </div>
  );
}
