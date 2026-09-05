import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, Play, Clock, ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/playground")({
  head: () => ({ meta: [{ title: "API Playground — Continuum" }] }),
  component: PlaygroundPage,
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const METHODS: Method[] = ["GET", "POST", "PATCH", "DELETE"];

const METHOD_STYLES: Record<Method, string> = {
  GET:    "bg-[oklch(0.96_0.04_145)] text-[oklch(0.35_0.15_145)] border-[oklch(0.82_0.12_145)]",
  POST:   "bg-[oklch(0.14_0_0)] text-[oklch(0.98_0_0)] border-[oklch(0.25_0_0)]",
  PATCH:  "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.12_75)]",
  DELETE: "bg-[oklch(0.97_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.85_0.12_27)]",
};

interface Preset { label: string; method: Method; path: string; body?: string; }
const PRESETS: Preset[] = [
  { label: "Verify email", method: "POST", path: "/v1/verify", body: '{\n  "email": "test@example.com"\n}' },
  { label: "Send email", method: "POST", path: "/v1/send", body: '{\n  "to": "recipient@example.com",\n  "from": "hello@yourdomain.com",\n  "subject": "Hello from Continuum",\n  "html": "<p>Hello world!</p>"\n}' },
  { label: "List messages", method: "GET", path: "/v1/messages?limit=10", body: "" },
  { label: "List domains", method: "GET", path: "/v1/domains", body: "" },
  { label: "List API keys", method: "GET", path: "/v1/api-keys", body: "" },
  { label: "List templates", method: "GET", path: "/v1/templates", body: "" },
  { label: "List suppressions", method: "GET", path: "/v1/suppressions?limit=20", body: "" },
  { label: "API usage", method: "GET", path: "/v1/usage", body: "" },
  { label: "Add suppression", method: "POST", path: "/v1/suppressions", body: '{\n  "email": "blocked@example.com",\n  "reason": "manual"\n}' },
  { label: "Add domain", method: "POST", path: "/v1/domains", body: '{\n  "name": "mail.yourdomain.com"\n}' },
  { label: "Bulk verify (upload)", method: "POST", path: "/v1/bulk", body: "// multipart/form-data: use curl or SDK for file uploads" },
  { label: "Analytics (30d)", method: "GET", path: "/v1/analytics/sends?date_from=" + new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), body: "" },
];

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted">
      {copied ? <Check className="h-3 w-3 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function formatJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function statusColor(code: number) {
  if (code >= 500) return "text-[oklch(0.58_0.22_27)]";
  if (code >= 400) return "text-[oklch(0.65_0.16_75)]";
  return "text-[oklch(0.55_0.16_145)]";
}

function PlaygroundPage() {
  const { primaryKey } = useAuth();

  const [method, setMethod] = useState<Method>("POST");
  const [path, setPath] = useState("/v1/verify");
  const [body, setBody] = useState('{\n  "email": "test@example.com"\n}');
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    statusText: string;
    latency: number;
    body: string;
    headers: Record<string, string>;
  } | null>(null);
  const [showPresets, setShowPresets] = useState(true);
  const [showHeaders, setShowHeaders] = useState(false);

  const apiKey = primaryKey?.keyRaw ?? "";
  const baseUrl = "https://api.continuumapi.com";

  const run = useCallback(async () => {
    if (!apiKey) { toast.error("No API key — go to API Keys first"); return; }
    const url = `${baseUrl}${path.startsWith("/") ? path : "/" + path}`;
    const hasBody = ["POST", "PATCH"].includes(method) && body.trim() && !body.trim().startsWith("//");
    setRunning(true);
    setResponse(null);
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "X-API-Key": apiKey,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body: hasBody ? body : undefined,
      });
      const latency = Math.round(performance.now() - t0);
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      setResponse({ status: res.status, statusText: res.statusText, latency, body: text, headers });
    } catch (e: unknown) {
      toast.error("Request failed: " + (e instanceof Error ? e.message : "Network error"));
    } finally {
      setRunning(false);
    }
  }, [apiKey, method, path, body]);

  const curlSnippet = `curl -X ${method} "${baseUrl}${path}" \\
  -H "X-API-Key: ${apiKey || "YOUR_KEY"}"${["POST", "PATCH"].includes(method) && body.trim() && !body.trim().startsWith("//") ? ` \\
  -H "Content-Type: application/json" \\
  -d '${body}'` : ""}`;

  const nodeSnippet = `const res = await fetch("${baseUrl}${path}", {
  method: "${method}",
  headers: {
    "X-API-Key": "${apiKey || "YOUR_KEY"}",${["POST", "PATCH"].includes(method) && body.trim() && !body.trim().startsWith("//") ? `
    "Content-Type": "application/json",` : ""}
  },${["POST", "PATCH"].includes(method) && body.trim() && !body.trim().startsWith("//") ? `
  body: JSON.stringify(${body}),` : ""}
});
const data = await res.json();`;

  const formattedResponse = response ? formatJson(response.body) : "";

  return (
    <div className="space-y-5 max-w-4xl">
      <header>
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical className="h-5 w-5" />
          <h1 className="text-2xl font-display font-medium tracking-tight">API Playground</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Test API calls directly in the browser with your live API key.
        </p>
      </header>

      {/* Presets */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
          onClick={() => setShowPresets((v) => !v)}
        >
          Quick presets
          {showPresets ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
        {showPresets && (
          <div className="px-4 pb-4 flex flex-wrap gap-2 border-t border-border pt-3">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => { setMethod(p.method); setPath(p.path); setBody(p.body ?? ""); }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted/60",
                  method === p.method && path === p.path
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground"
                )}
              >
                <span className={cn("font-mono text-[10px] font-bold", METHOD_STYLES[p.method].split(" ").find(c => c.startsWith("text-")))}>{p.method}</span>
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Request builder */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Request</p>
        </div>
        <div className="p-4 space-y-4">
          {/* Method + URL */}
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as Method)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm font-mono font-bold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring w-28 shrink-0"
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <Input
              className="flex-1 font-mono text-sm"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/v1/verify"
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
            <Button onClick={run} disabled={running || !apiKey} className="gap-1.5 shrink-0">
              <Play className="h-3.5 w-3.5" />
              {running ? "Running…" : "Send"}
            </Button>
          </div>

          {/* Body */}
          {["POST", "PATCH"].includes(method) && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Body (JSON)</p>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] px-4 py-3 text-xs font-mono leading-relaxed resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      {/* Response */}
      {response && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={cn("text-sm font-bold tabular-nums", statusColor(response.status))}>
                {response.status} {response.statusText}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {response.latency}ms
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
                onClick={() => setShowHeaders((v) => !v)}
              >
                {showHeaders ? "Hide headers" : "View headers"}
              </button>
              <CopyButton text={formattedResponse} label="Copy response" />
            </div>
          </div>

          {showHeaders && (
            <div className="border-b border-border px-4 py-3 space-y-1">
              {Object.entries(response.headers).slice(0, 12).map(([k, v]) => (
                <div key={k} className="flex gap-3 text-xs font-mono">
                  <span className="text-muted-foreground w-48 shrink-0 truncate">{k}</span>
                  <span className="text-foreground/80 truncate">{v}</span>
                </div>
              ))}
            </div>
          )}

          <pre className="px-4 py-4 text-xs font-mono leading-relaxed text-[oklch(0.88_0_0)] bg-[oklch(0.12_0_0)] overflow-x-auto max-h-96">
            <code>{formattedResponse || response.body}</code>
          </pre>
        </div>
      )}

      {/* Code snippets */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Code equivalent</p>
        </div>
        <div className="divide-y divide-border">
          {[
            { label: "cURL", code: curlSnippet },
            { label: "Node.js (fetch)", code: nodeSnippet },
          ].map(({ label, code }) => (
            <div key={label}>
              <div className="flex items-center justify-between px-4 py-2 bg-muted/20">
                <span className="text-xs font-mono font-medium">{label}</span>
                <CopyButton text={code} />
              </div>
              <pre className="px-4 py-3 text-xs font-mono leading-relaxed bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] overflow-x-auto">
                <code>{code}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>

      {!apiKey && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          No API key found. Go to <a href="/dashboard/api-keys" className="underline">API Keys</a> to create one.
        </div>
      )}
    </div>
  );
}
