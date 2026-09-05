import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Send, CheckCircle2, XCircle, Layers, Upload, Table2 } from "lucide-react";

export const Route = createFileRoute("/dashboard/batch-send")({
  head: () => ({ meta: [{ title: "Batch Send — Continuum API" }] }),
  component: BatchSendPage,
});

interface Recipient { email: string; vars: Record<string, string>; }
interface BatchResult { id: string; status: string; error?: string; to: string; }

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line: string) => {
    const cols: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === "," && !quoted) { cols.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur);
    return cols.map((c) => c.trim());
  };
  const headers = splitLine(lines[0]!);
  const rows = lines.slice(1).map((l) => {
    const vals = splitLine(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

function getDefaultFrom(): string {
  try { return JSON.parse(localStorage.getItem("cnt_default_from") ?? '""') as string; } catch { return ""; }
}

function BatchSendPage() {
  const { primaryKey } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [from, setFrom] = useState(getDefaultFrom);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [manualText, setManualText] = useState("");
  const [mode, setMode] = useState<"manual" | "csv">("manual");

  const [form, setForm] = useState({
    subject: "",
    htmlBody: "",
    textBody: "",
    replyTo: "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [summary, setSummary] = useState<{ sent: number; total: number } | null>(null);

  // Build recipient list
  const emailCol = csvHeaders.find((h) => /email/i.test(h)) ?? csvHeaders[0];
  const varCols = csvHeaders.filter((h) => h !== emailCol);

  const activeRecipients: Recipient[] = mode === "csv" ? recipients : (() => {
    const emails = manualText.split(/[\n,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
    return [...new Set(emails)].map((email) => ({ email, vars: {} }));
  })();

  const unique = [...new Map(activeRecipients.map((r) => [r.email, r])).values()];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, rows } = parseCsv(text);
      setCsvHeaders(headers);
      const emailH = headers.find((h) => /email/i.test(h)) ?? headers[0];
      const parsed: Recipient[] = rows
        .map((row) => ({ email: (row[emailH ?? ""] ?? "").toLowerCase(), vars: row }))
        .filter((r) => r.email.includes("@") && r.email.includes("."));
      setRecipients(parsed);
      setMode("csv");
      toast.success(`Loaded ${parsed.length} recipients from CSV`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const previewFirst = unique[0];
  const previewSubject = previewFirst ? applyVars(form.subject, previewFirst.vars) : form.subject;
  const previewHtml = previewFirst ? applyVars(form.htmlBody, previewFirst.vars) : form.htmlBody;

  const send = async () => {
    if (!primaryKey?.keyRaw) return;
    if (unique.length === 0) { toast.error("Enter at least one valid email address"); return; }
    if (!form.subject.trim()) { toast.error("Subject is required"); return; }
    if (!form.htmlBody.trim() && !form.textBody.trim()) { toast.error("HTML or text body is required"); return; }
    if (!from.trim()) { toast.error("From address is required"); return; }
    if (unique.length > 100) { toast.error("Maximum 100 recipients per batch"); return; }

    setSending(true);
    setResults(null);
    setSummary(null);

    // API takes from_name/from_email at the batch level (one sender per
    // batch), not a per-message "from" string — the schema didn't recognize
    // "from" at all, so every batch send silently used the generic fallback
    // sender regardless of what was typed here.
    const fromMatch = from.trim().match(/^(.*)<(.+)>$/);
    const fromEmail = (fromMatch ? fromMatch[2] : from).trim();
    const fromName = fromMatch ? fromMatch[1].trim() : undefined;

    const messages = unique.map((r) => ({
      to: r.email,
      subject: applyVars(form.subject.trim(), r.vars),
      ...(form.htmlBody.trim() ? { html_body: applyVars(form.htmlBody.trim(), r.vars) } : {}),
      ...(form.textBody.trim() ? { text_body: applyVars(form.textBody.trim(), r.vars) } : {}),
      ...(form.replyTo.trim() ? { reply_to: form.replyTo.trim() } : {}),
    }));

    try {
      const res = await fetch("https://api.continuumapi.com/v1/send/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ from_email: fromEmail || undefined, from_name: fromName || undefined, messages }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);

      const typed = data as { results: Array<{ id: string; status: string; error?: string }>; sent: number; total: number };
      const withTo = (typed.results ?? []).map((r, i) => ({ ...r, to: unique[i]?.email ?? "" }));
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
        <p className="text-sm text-muted-foreground">
          Send personalized emails to up to 100 recipients. Upload a CSV to use merge variables like{" "}
          <code className="text-xs bg-muted rounded px-1">{"{{first_name}}"}</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: form */}
        <div className="space-y-5 rounded-lg border border-border bg-card p-6">
          {/* From */}
          <div className="space-y-1.5">
            <Label htmlFor="from">From *</Label>
            <Input id="from" placeholder="noreply@yourapp.com" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>

          {/* Recipients */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Recipients *</Label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMode("manual")}
                  className={`text-xs px-2 py-0.5 rounded ${mode === "manual" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Manual
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload CSV
                </button>
                <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileUpload} />
              </div>
            </div>

            {mode === "csv" && recipients.length > 0 ? (
              <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">{unique.length} recipients from CSV</span>
                  <button
                    type="button"
                    onClick={() => { setMode("manual"); setRecipients([]); setCsvHeaders([]); }}
                    className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                </div>
                {varCols.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    <span className="text-[10px] text-muted-foreground mr-1">Variables available:</span>
                    {varCols.map((h) => (
                      <code key={h} className="text-[10px] bg-muted rounded px-1">{`{{${h}}}`}</code>
                    ))}
                  </div>
                )}
                {unique.slice(0, 4).map((r) => (
                  <p key={r.email} className="text-xs font-mono text-muted-foreground mt-0.5 truncate">{r.email}</p>
                ))}
                {unique.length > 4 && <p className="text-[10px] text-muted-foreground mt-0.5">+{unique.length - 4} more</p>}
              </div>
            ) : (
              <div className="space-y-1.5">
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[100px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder={"alice@company.com\nbob@company.com\ncharlie@company.com"}
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                />
                {unique.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {unique.length} unique address{unique.length !== 1 ? "es" : ""}
                    {unique.length > 100 && <span className="text-destructive font-medium"> — max 100</span>}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Subject */}
          <div className="space-y-1.5">
            <Label>Subject *</Label>
            <Input
              placeholder={varCols.length > 0 ? `Hi {{${varCols[0]}}}, here's your update` : "Your subject line"}
              value={form.subject}
              onChange={set("subject")}
            />
          </div>

          {/* HTML Body */}
          <div className="space-y-1.5">
            <Label>HTML body</Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={varCols.length > 0
                ? `<p>Hi {{${varCols[0]}}},</p>\n<p>Here's your update.</p>`
                : "<p>Hi there,</p>\n<p>Here's your update.</p>"}
              value={form.htmlBody}
              onChange={set("htmlBody")}
            />
          </div>

          {/* Text */}
          <div className="space-y-1.5">
            <Label>Plain text <span className="text-muted-foreground font-normal">(optional fallback)</span></Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Hi there, here's your update."
              value={form.textBody}
              onChange={set("textBody")}
            />
          </div>

          {/* Reply-To */}
          <div className="space-y-1.5">
            <Label>Reply-To <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input type="email" placeholder="replies@yourapp.com" value={form.replyTo} onChange={set("replyTo")} />
          </div>

          <Button
            onClick={send}
            disabled={sending || unique.length === 0 || unique.length > 100 || !from.trim()}
            className="w-full gap-1.5"
          >
            <Send className="h-4 w-4" />
            {sending ? `Sending to ${unique.length}…` : `Send to ${unique.length || "—"} recipients`}
          </Button>
        </div>

        {/* Right: preview + results */}
        <div className="space-y-4">
          {/* Live preview for first recipient */}
          {(form.subject || form.htmlBody) && unique.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
                <span className="text-xs font-medium text-muted-foreground">Preview</span>
                {previewFirst && varCols.length > 0 && (
                  <span className="text-[10px] text-muted-foreground ml-auto">showing variables for {previewFirst.email}</span>
                )}
              </div>
              {previewSubject && (
                <div className="px-4 py-2 border-b border-border">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject: </span>
                  <span className="text-sm font-medium">{previewSubject}</span>
                </div>
              )}
              {previewHtml && (
                <div className="p-2">
                  <iframe
                    key={previewHtml}
                    srcDoc={`<html><head><style>body{margin:8px;font-family:sans-serif;font-size:14px}</style></head><body>${previewHtml}</body></html>`}
                    sandbox="allow-same-origin"
                    className="w-full rounded border-0"
                    style={{ minHeight: 120, maxHeight: 240 }}
                    title="Preview"
                  />
                </div>
              )}
            </div>
          )}

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
                          <td className="px-3 py-1.5 text-muted-foreground max-w-[140px] truncate">
                            {r.error ?? (r.id ? <span className="font-mono">{r.id.slice(0, 8)}…</span> : "—")}
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
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">CSV format</p>
            <pre className="text-xs font-mono text-foreground overflow-x-auto whitespace-pre">
{`email,first_name,company
alice@company.com,Alice,Acme
bob@company.com,Bob,Globex`}
            </pre>
            <p className="text-[10px] text-muted-foreground">Any column becomes a merge variable. Use <code>{"{{first_name}}"}</code> in subject/body.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
