import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Copy, Check, ChevronDown, ChevronRight, Code2, Lock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/api-reference")({
  head: () => ({ meta: [{ title: "API Reference — Continuum API" }] }),
  component: ApiReferencePage,
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Param {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

interface EndpointDef {
  method: Method;
  path: string;
  summary: string;
  auth: "apikey" | "session";
  params?: Param[];
  body?: Param[];
  example?: string;
  response?: string;
}

interface Section {
  id: string;
  title: string;
  endpoints: EndpointDef[];
}

const SECTIONS: Section[] = [
  {
    id: "verify",
    title: "Email Verification",
    endpoints: [
      {
        method: "POST",
        path: "/v1/verify",
        summary: "Verify a single email address. Returns syntax, MX, SMTP, and deliverability signals.",
        auth: "apikey",
        body: [
          { name: "email", type: "string", required: true, description: "The email address to verify." },
          { name: "timeout_ms", type: "number", description: "SMTP check timeout in ms (default 8000, max 20000)." },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/verify \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "test@example.com"}'`,
        response: `{
  "email": "test@example.com",
  "status": "valid",          // valid | invalid | risky | unknown
  "score": 92,                // 0-100 confidence
  "syntax_valid": true,
  "mx_found": true,
  "smtp_reachable": true,
  "is_disposable": false,
  "is_role_account": false,
  "is_catch_all": false,
  "duration_ms": 430
}`,
      },
      {
        method: "POST",
        path: "/v1/bulk",
        summary: "Upload a CSV file for bulk verification. Returns a job ID to poll.",
        auth: "apikey",
        body: [
          { name: "file", type: "File (multipart)", required: true, description: "CSV file with an email column. Max 200k rows." },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/bulk \\
  -H "X-API-Key: YOUR_KEY" \\
  -F "file=@contacts.csv"`,
        response: `{
  "jobId": "cjb_abc123",
  "status": "pending",
  "totalEmails": 5000,
  "createdAt": "2026-09-03T10:00:00Z"
}`,
      },
      {
        method: "GET",
        path: "/v1/bulk/:jobId",
        summary: "Poll a bulk verification job for progress and download results.",
        auth: "apikey",
        params: [{ name: "jobId", type: "string", required: true, description: "Job ID returned from POST /v1/bulk." }],
        response: `{
  "id": "cjb_abc123",
  "status": "completed",      // pending | processing | completed | failed
  "totalEmails": 5000,
  "processedCount": 5000,
  "validCount": 4312,
  "invalidCount": 388,
  "riskyCount": 210,
  "exportPath": "https://..."  // signed CSV download URL
}`,
      },
    ],
  },
  {
    id: "send",
    title: "Transactional Email",
    endpoints: [
      {
        method: "POST",
        path: "/v1/send",
        summary: "Send a transactional email. Supports HTML, templates, attachments, and scheduling.",
        auth: "apikey",
        body: [
          { name: "to", type: "string | string[]", required: true, description: "Recipient email(s). Max 50 per call." },
          { name: "from", type: "string", required: true, description: "Sender address. Must be on a verified domain." },
          { name: "subject", type: "string", required: true, description: "Email subject line." },
          { name: "html", type: "string", description: "HTML body. Either html or text (or both) required." },
          { name: "text", type: "string", description: "Plain-text fallback body." },
          { name: "reply_to", type: "string", description: "Reply-To address." },
          { name: "template_id", type: "string", description: "Use a saved template instead of html/text. Variables merged from the variables field." },
          { name: "variables", type: "object", description: "Key-value pairs substituted into {{variable}} placeholders in subject and body." },
          { name: "scheduled_at", type: "ISO 8601 datetime", description: "Schedule the send for a future time (UTC)." },
          { name: "idempotency_key", type: "string", description: "Prevent duplicate sends. Same key within 24h returns the original send result." },
          { name: "tags", type: "object", description: "Arbitrary key-value tags stored with the message (for filtering in analytics)." },
          { name: "headers", type: "object", description: "Custom email headers to include (e.g. List-Unsubscribe)." },
          { name: "domain_id", type: "string", description: "Override which verified domain to send from." },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/send \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "customer@example.com",
    "from": "hello@yourdomain.com",
    "subject": "Your receipt for order #{{order_id}}",
    "template_id": "tmpl_abc123",
    "variables": { "order_id": "ORD-9876", "amount": "$49.00" },
    "idempotency_key": "order-9876-receipt"
  }'`,
        response: `{
  "id": "msg_xyz789",
  "status": "sent",
  "to": "customer@example.com",
  "from": "hello@yourdomain.com",
  "subject": "Your receipt for order #ORD-9876",
  "sentAt": "2026-09-03T10:01:23Z"
}`,
      },
      {
        method: "POST",
        path: "/v1/send/batch",
        summary: "Send up to 1,000 personalised emails in one call. Each recipient can have unique variables.",
        auth: "apikey",
        body: [
          { name: "messages", type: "array", required: true, description: "Array of message objects (same schema as /v1/send). Max 1000." },
        ],
        response: `{
  "sent": 998,
  "failed": 2,
  "results": [
    { "to": "alice@example.com", "id": "msg_001", "status": "sent" },
    { "to": "bounced@invalid.com", "status": "error", "error": "Suppressed address" }
  ]
}`,
      },
      {
        method: "GET",
        path: "/v1/messages",
        summary: "List sent messages with filtering by status, date, domain, and recipient.",
        auth: "apikey",
        params: [
          { name: "status", type: "string", description: "Filter: sent | delivered | bounced | complained | failed" },
          { name: "date_from", type: "ISO 8601", description: "Start of date range." },
          { name: "date_to", type: "ISO 8601", description: "End of date range." },
          { name: "limit", type: "number", description: "Page size (default 50, max 100)." },
          { name: "cursor", type: "string", description: "Pagination cursor from previous response." },
        ],
      },
    ],
  },
  {
    id: "contacts",
    title: "Contacts & Lists",
    endpoints: [
      {
        method: "POST",
        path: "/v1/contacts/import",
        summary: "Bulk import contacts and suppressions. Handles up to 50,000 contacts per request.",
        auth: "apikey",
        body: [
          { name: "contacts", type: "array", required: true, description: "Array of {email, first_name?, last_name?} objects." },
          { name: "list_id", type: "string", description: "Add imported contacts to this list." },
          { name: "list_name", type: "string", description: "Create a new list and add contacts to it." },
          { name: "suppressions", type: "array", description: "Array of {email, reason} to add to the global suppression list." },
          { name: "source_platform", type: "string", description: "Tag the import source: mailchimp | sendgrid | klaviyo | csv" },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/contacts/import \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contacts": [
      {"email": "alice@example.com", "first_name": "Alice"},
      {"email": "bob@example.com", "first_name": "Bob"}
    ],
    "list_name": "Newsletter subscribers",
    "source_platform": "mailchimp"
  }'`,
        response: `{
  "imported": 2,
  "skipped": 0,
  "suppressions_added": 0,
  "list_id": "lst_abc123"
}`,
      },
      {
        method: "GET",
        path: "/v1/lists",
        summary: "List all mailing lists with contact counts.",
        auth: "apikey",
      },
      {
        method: "POST",
        path: "/v1/lists",
        summary: "Create a new mailing list.",
        auth: "apikey",
        body: [
          { name: "name", type: "string", required: true, description: "List name." },
          { name: "description", type: "string", description: "Optional description." },
        ],
      },
    ],
  },
  {
    id: "suppressions",
    title: "Suppressions",
    endpoints: [
      {
        method: "GET",
        path: "/v1/suppressions",
        summary: "List suppressed addresses. Filtered by reason or date range.",
        auth: "apikey",
        params: [
          { name: "reason", type: "string", description: "hard_bounce | complaint | manual | soft_bounce | unsubscribed" },
          { name: "limit", type: "number", description: "Page size (default 50, max 1000)." },
          { name: "cursor", type: "string", description: "Pagination cursor." },
        ],
      },
      {
        method: "POST",
        path: "/v1/suppressions",
        summary: "Manually suppress an email address.",
        auth: "apikey",
        body: [
          { name: "email", type: "string", required: true, description: "Address to suppress." },
          { name: "reason", type: "string", description: "manual | unsubscribed (default: manual)" },
        ],
      },
      {
        method: "DELETE",
        path: "/v1/suppressions/:email",
        summary: "Remove an address from the suppression list.",
        auth: "apikey",
        params: [{ name: "email", type: "string", required: true, description: "URL-encoded email address." }],
      },
    ],
  },
  {
    id: "domains",
    title: "Sending Domains",
    endpoints: [
      {
        method: "GET",
        path: "/v1/domains",
        summary: "List all sending domains and their authentication status.",
        auth: "apikey",
      },
      {
        method: "POST",
        path: "/v1/domains",
        summary: "Add a sending domain. Returns DNS records to configure.",
        auth: "apikey",
        body: [
          { name: "name", type: "string", required: true, description: "Domain name (e.g. mail.yourdomain.com)." },
          { name: "region", type: "string", description: "AWS region (default: us-east-1)." },
        ],
      },
      {
        method: "POST",
        path: "/v1/domains/:id/verify",
        summary: "Re-check DNS records and verify the domain.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Domain ID." }],
      },
      {
        method: "GET",
        path: "/v1/domains/:id/health",
        summary: "Full SPF, DKIM, DMARC, and blacklist health check.",
        auth: "apikey",
      },
    ],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    endpoints: [
      {
        method: "GET",
        path: "/v1/webhooks",
        summary: "List all webhook endpoints with delivery statistics.",
        auth: "apikey",
      },
      {
        method: "POST",
        path: "/v1/webhooks",
        summary: "Register a new webhook endpoint.",
        auth: "apikey",
        body: [
          { name: "url", type: "string", required: true, description: "HTTPS endpoint URL." },
          { name: "events", type: "string[]", required: true, description: "Events to subscribe to: verification.completed, email.sent, email.delivered, email.bounced, email.complained, bulk_job.completed, email.status_changed" },
          { name: "label", type: "string", description: "Human-readable name." },
        ],
      },
      {
        method: "POST",
        path: "/v1/webhooks/:id/rotate-secret",
        summary: "Rotate the HMAC signing secret. Displayed once — store it immediately.",
        auth: "apikey",
      },
    ],
  },
  {
    id: "analytics",
    title: "Analytics",
    endpoints: [
      {
        method: "GET",
        path: "/v1/analytics/sends",
        summary: "Aggregate sending metrics: sent, delivered, bounced, complained, open_rate, click_rate.",
        auth: "apikey",
        params: [
          { name: "date_from", type: "ISO 8601", description: "Start date (default: 30 days ago)." },
          { name: "date_to", type: "ISO 8601", description: "End date (default: now)." },
          { name: "domain_id", type: "string", description: "Filter to a specific sending domain." },
        ],
      },
      {
        method: "GET",
        path: "/v1/analytics/sends/timeline",
        summary: "Day-by-day delivery stats for charting.",
        auth: "apikey",
        params: [
          { name: "date_from", type: "ISO 8601", description: "Start date." },
          { name: "date_to", type: "ISO 8601", description: "End date." },
        ],
      },
      {
        method: "GET",
        path: "/v1/analytics/domains",
        summary: "Per-domain breakdown of sends, delivery, bounce, and complaint rates.",
        auth: "apikey",
      },
    ],
  },
];

const METHOD_STYLES: Record<Method, string> = {
  GET:    "bg-[oklch(0.96_0.04_145)] text-[oklch(0.35_0.15_145)] border-[oklch(0.82_0.12_145)]",
  POST:   "bg-[oklch(0.14_0_0)] text-[oklch(0.98_0_0)] border-[oklch(0.25_0_0)]",
  PATCH:  "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.12_75)]",
  DELETE: "bg-[oklch(0.97_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.85_0.12_27)]",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function EndpointCard({ ep, apiKeyHint }: { ep: EndpointDef; apiKeyHint: string }) {
  const [open, setOpen] = useState(false);
  const exampleWithKey = ep.example?.replace("YOUR_KEY", apiKeyHint || "YOUR_KEY");

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-mono font-semibold shrink-0", METHOD_STYLES[ep.method])}>
          {ep.method}
        </span>
        <code className="text-sm font-mono text-foreground flex-1 truncate">{ep.path}</code>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:block truncate max-w-xs">{ep.summary}</span>
          {ep.auth === "apikey" ? (
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border bg-muted/10 px-4 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">{ep.summary}</p>

          {(ep.params && ep.params.length > 0) && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Path / Query Parameters</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground border-b border-border">
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ep.params.map((p) => (
                      <tr key={p.name}>
                        <td className="px-3 py-2 font-mono">
                          {p.name}
                          {p.required && <span className="text-[oklch(0.58_0.22_27)] ml-1">*</span>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground font-mono">{p.type}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(ep.body && ep.body.length > 0) && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Request Body</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground border-b border-border">
                      <th className="px-3 py-2 text-left font-medium">Field</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ep.body.map((p) => (
                      <tr key={p.name}>
                        <td className="px-3 py-2 font-mono">
                          {p.name}
                          {p.required && <span className="text-[oklch(0.58_0.22_27)] ml-1">*</span>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground font-mono">{p.type}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {exampleWithKey && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Example</p>
                <CopyButton text={exampleWithKey} />
              </div>
              <pre className="rounded-md bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] text-xs p-4 overflow-x-auto font-mono leading-relaxed">
                <code>{exampleWithKey}</code>
              </pre>
            </div>
          )}

          {ep.response && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Response</p>
                <CopyButton text={ep.response} />
              </div>
              <pre className="rounded-md bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] text-xs p-4 overflow-x-auto font-mono leading-relaxed">
                <code>{ep.response}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { KeyRound } from "lucide-react";

function ApiReferencePage() {
  const { primaryKey } = useAuth();
  const [activeSection, setActiveSection] = useState("verify");
  const apiKeyHint = primaryKey?.keyRaw ? `${primaryKey.keyRaw.slice(0, 12)}…` : "YOUR_KEY";

  const section = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0]!;

  return (
    <div className="flex gap-6 max-w-6xl">
      {/* Sidebar */}
      <aside className="w-44 shrink-0 hidden md:block">
        <div className="sticky top-4 space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-2 mb-3">
            Reference
          </p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={cn(
                "w-full text-left text-sm px-2 py-1.5 rounded-md transition-colors",
                activeSection === s.id
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {s.title}
            </button>
          ))}
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-6">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">API Reference</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All requests use base URL <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">https://api.continuumapi.com</code>.
            Authenticate with <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">X-API-Key: {apiKeyHint}</code>.
          </p>
        </header>

        {/* Mobile section picker */}
        <div className="md:hidden">
          <select
            value={activeSection}
            onChange={(e) => setActiveSection(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
            <Code2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{section.title}</h2>
            <span className="text-xs text-muted-foreground ml-auto">{section.endpoints.length} endpoint{section.endpoints.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="p-4 space-y-3">
            {section.endpoints.map((ep) => (
              <EndpointCard key={`${ep.method}-${ep.path}`} ep={ep} apiKeyHint={primaryKey?.keyRaw ?? ""} />
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Globe className="h-3.5 w-3.5" />
            Authentication
          </div>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">X-API-Key</code> header — use your full API key.
            Alternatively, <code className="font-mono">Authorization: Bearer YOUR_KEY</code>.
            Rate limits: 1,000 requests/min by default. 429 when exceeded.
          </p>
        </div>
      </div>
    </div>
  );
}
