import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Copy, Check, ChevronDown, ChevronRight, Code2, Lock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/api-reference")({
  head: () => ({ meta: [{ title: "API Reference — Continuum" }] }),
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
  example?: string;      // cURL
  nodeExample?: string;  // Node.js / TypeScript
  pythonExample?: string; // Python
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
        nodeExample: `import Continuum from "@continuum/sdk";

const client = new Continuum({ apiKey: "YOUR_KEY" });

const result = await client.verify.single({
  email: "test@example.com",
});

console.log(result.status, result.score);
// "valid" 92`,
        pythonExample: `from continuum import Continuum

client = Continuum(api_key="YOUR_KEY")

result = client.verify.single(email="test@example.com")
print(result.status, result.score)
# "valid" 92`,
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
        nodeExample: `import Continuum from "@continuum/sdk";
import { createReadStream } from "fs";

const client = new Continuum({ apiKey: "YOUR_KEY" });

const job = await client.bulk.upload({
  file: createReadStream("contacts.csv"),
});

console.log(job.jobId, job.status);
// "cjb_abc123" "pending"`,
        pythonExample: `from continuum import Continuum

client = Continuum(api_key="YOUR_KEY")

with open("contacts.csv", "rb") as f:
    job = client.bulk.upload(file=f)

print(job.job_id, job.status)
# "cjb_abc123" "pending"`,
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
        nodeExample: `import Continuum from "@continuum/sdk";

const client = new Continuum({ apiKey: "YOUR_KEY" });

const msg = await client.email.send({
  to: "customer@example.com",
  from: "hello@yourdomain.com",
  subject: "Your receipt for order #{{order_id}}",
  templateId: "tmpl_abc123",
  variables: { order_id: "ORD-9876", amount: "$49.00" },
  idempotencyKey: "order-9876-receipt",
});

console.log(msg.id, msg.status);
// "msg_xyz789" "sent"`,
        pythonExample: `from continuum import Continuum

client = Continuum(api_key="YOUR_KEY")

msg = client.email.send(
    to="customer@example.com",
    from_="hello@yourdomain.com",
    subject="Your receipt for order #{{order_id}}",
    template_id="tmpl_abc123",
    variables={"order_id": "ORD-9876", "amount": "$49.00"},
    idempotency_key="order-9876-receipt",
)

print(msg.id, msg.status)
# "msg_xyz789" "sent"`,
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
        nodeExample: `import Continuum from "@continuum/sdk";

const client = new Continuum({ apiKey: "YOUR_KEY" });

const result = await client.contacts.import({
  contacts: [
    { email: "alice@example.com", firstName: "Alice" },
    { email: "bob@example.com", firstName: "Bob" },
  ],
  listName: "Newsletter subscribers",
  sourcePlatform: "mailchimp",
});

console.log(\`Imported: \${result.imported}\`);
// "Imported: 2"`,
        pythonExample: `from continuum import Continuum

client = Continuum(api_key="YOUR_KEY")

result = client.contacts.import_contacts(
    contacts=[
        {"email": "alice@example.com", "first_name": "Alice"},
        {"email": "bob@example.com", "first_name": "Bob"},
    ],
    list_name="Newsletter subscribers",
    source_platform="mailchimp",
)

print(f"Imported: {result.imported}")
# "Imported: 2"`,
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
  {
    id: "campaigns",
    title: "Campaigns",
    endpoints: [
      {
        method: "GET",
        path: "/v1/campaigns",
        summary: "List campaigns with status, recipient counts, and engagement metrics.",
        auth: "apikey",
        params: [
          { name: "status", type: "string", description: "Filter by status: draft | scheduled | sending | sent | failed | cancelled" },
          { name: "limit", type: "number", description: "Page size (default 50)." },
          { name: "page", type: "number", description: "Page number (default 1)." },
        ],
        response: `{
  "data": [{
    "id": "cmp_abc123",
    "name": "May Newsletter",
    "fromName": "Acme Inc.",
    "fromEmail": "hello@mail.acme.com",
    "subject": "Your May update is here",
    "status": "sent",
    "totalRecipients": 4820,
    "sentCount": 4818,
    "openCount": 1205,
    "clickCount": 312,
    "bounceCount": 2,
    "complaintCount": 0,
    "trackOpens": true,
    "trackClicks": true,
    "sentAt": "2026-05-12T10:00:00Z"
  }],
  "total": 1
}`,
      },
      {
        method: "POST",
        path: "/v1/campaigns",
        summary: "Create a campaign. Send immediately or schedule for later.",
        auth: "apikey",
        body: [
          { name: "name", type: "string", description: "Campaign display name (defaults to subject)." },
          { name: "from_name", type: "string", required: true, description: "Sender display name." },
          { name: "from_email", type: "string", required: true, description: "Verified sending address." },
          { name: "reply_to", type: "string", description: "Reply-to address (optional)." },
          { name: "subject", type: "string", required: true, description: "Email subject line." },
          { name: "html_body", type: "string", required: true, description: "HTML email body. Supports {{first_name}}, {{email}}, {{unsubscribe_url}} tokens." },
          { name: "text_body", type: "string", description: "Plain-text fallback (recommended for deliverability)." },
          { name: "list_ids", type: "string[]", description: "Mailing list IDs to send to." },
          { name: "segment_ids", type: "string[]", description: "Segment IDs — filters list recipients by matching rules." },
          { name: "exclude_list_ids", type: "string[]", description: "Contacts in these lists are excluded from delivery." },
          { name: "track_opens", type: "boolean", description: "Enable open tracking (default true)." },
          { name: "track_clicks", type: "boolean", description: "Enable click tracking (default true)." },
          { name: "scheduled_at", type: "ISO 8601", description: "Schedule send time. If omitted, campaign is saved as draft." },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/campaigns \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from_name": "Acme Inc.",
    "from_email": "hello@mail.acme.com",
    "subject": "Your May update is here",
    "html_body": "<p>Hi {{first_name}},</p><p>...</p>",
    "text_body": "Hi {{first_name}}, ...",
    "list_ids": ["lst_abc123"],
    "track_opens": true,
    "track_clicks": true
  }'`,
        response: `{
  "id": "cmp_abc123",
  "status": "draft",
  "totalRecipients": 0,
  "createdAt": "2026-05-01T09:00:00Z"
}`,
      },
      {
        method: "POST",
        path: "/v1/campaigns/:id/send",
        summary: "Queue a draft campaign for immediate sending.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Campaign ID." }],
      },
      {
        method: "POST",
        path: "/v1/campaigns/:id/cancel",
        summary: "Cancel a scheduled campaign and revert it to draft.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Campaign ID." }],
      },
      {
        method: "PATCH",
        path: "/v1/campaigns/:id",
        summary: "Update a draft or scheduled campaign.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Campaign ID." }],
        body: [
          { name: "subject", type: "string", description: "New subject line." },
          { name: "subject_b", type: "string", description: "Variant B subject for A/B testing (50/50 split)." },
          { name: "html_body", type: "string", description: "New HTML body." },
          { name: "text_body", type: "string", description: "New plain-text body." },
          { name: "reply_to", type: "string", description: "New reply-to address." },
          { name: "track_opens", type: "boolean", description: "Toggle open tracking." },
          { name: "track_clicks", type: "boolean", description: "Toggle click tracking." },
          { name: "scheduled_at", type: "ISO 8601", description: "Reschedule send time." },
          { name: "send_rate_per_hour", type: "number", description: "Drip rate limit (10–50000 emails/hr). Omit for unlimited." },
        ],
      },
      {
        method: "POST",
        path: "/v1/campaigns/:id/retarget",
        summary: "Create a follow-up campaign targeting non-openers of a sent campaign.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Source campaign ID." }],
        response: `{ "campaign_id": "c_abc", "non_openers": 412, "total_sent": 1000 }`,
      },
      {
        method: "GET",
        path: "/v1/campaigns/:id/health",
        summary: "Real-time deliverability health score (0–100) with bounce, complaint, and delivery signal flags.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Campaign ID." }],
        response: `{ "health_score": 87, "signals": [{ "type": "good", "message": "..." }], "metrics": { "sent": 1000, "bounced": 12, "complained": 1 } }`,
      },
    ],
  },
  {
    id: "templates",
    title: "Email Templates",
    endpoints: [
      {
        method: "GET",
        path: "/v1/templates",
        summary: "List saved email templates.",
        auth: "apikey",
        params: [
          { name: "limit", type: "number", description: "Page size (default 50)." },
          { name: "cursor", type: "string", description: "Pagination cursor." },
        ],
      },
      {
        method: "POST",
        path: "/v1/templates",
        summary: "Create a new email template.",
        auth: "apikey",
        body: [
          { name: "name", type: "string", required: true, description: "Template name." },
          { name: "subject", type: "string", required: true, description: "Default subject line." },
          { name: "html_body", type: "string", required: true, description: "HTML body content." },
          { name: "text_body", type: "string", description: "Plain-text fallback." },
          { name: "category", type: "string", description: "Optional grouping label." },
        ],
      },
      {
        method: "PATCH",
        path: "/v1/templates/:id",
        summary: "Update a template. Automatically snapshots the previous version before saving.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Template ID." }],
        body: [
          { name: "name", type: "string", description: "New name." },
          { name: "subject", type: "string", description: "New subject." },
          { name: "html_body", type: "string", description: "New HTML body." },
          { name: "text_body", type: "string", description: "New plain-text body." },
        ],
      },
      {
        method: "GET",
        path: "/v1/templates/:id/versions",
        summary: "List all saved versions of a template (auto-created on each PATCH).",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Template ID." }],
        response: `{
  "data": [{
    "id": "tv_abc",
    "versionNumber": 3,
    "subject": "Old subject line",
    "createdAt": "2026-04-30T14:22:00Z"
  }]
}`,
      },
      {
        method: "POST",
        path: "/v1/templates/:id/versions/:versionId/restore",
        summary: "Restore a template to a previous version. The current content is snapshotted first.",
        auth: "apikey",
        params: [
          { name: "id", type: "string", required: true, description: "Template ID." },
          { name: "versionId", type: "string", required: true, description: "Version ID to restore." },
        ],
      },
      {
        method: "POST",
        path: "/v1/templates/:id/test-send",
        summary: "Send a live preview email of the template to any address. Replaces {{ variable }} placeholders with supplied values.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Template ID." }],
        body: [
          { name: "to", type: "string", required: true, description: "Recipient email for the test." },
          { name: "from_name", type: "string", required: true, description: "Sender display name." },
          { name: "from_email", type: "string", required: true, description: "Sender email address." },
          { name: "variables", type: "object", description: "Key/value map to fill template placeholders." },
        ],
        response: `{ "sent": true, "to": "you@example.com", "subject": "[TEST] Welcome aboard!" }`,
      },
    ],
  },
  {
    id: "lists-hygiene",
    title: "List Hygiene",
    endpoints: [
      {
        method: "GET",
        path: "/v1/lists/:id/hygiene",
        summary: "Analyse contact engagement health. Returns counts by tier: active, at_risk, dormant, never_opened.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Mailing list ID." }],
        response: `{
  "listId": "lst_abc123",
  "listName": "Newsletter subscribers",
  "totalContacts": 9800,
  "breakdown": {
    "active":       { "count": 6120, "pct": 62.4 },
    "at_risk":      { "count": 1540, "pct": 15.7 },
    "dormant":      { "count":  980, "pct": 10.0 },
    "never_opened": { "count": 1160, "pct": 11.8 }
  },
  "recommendations": ["Suppress 2140 dormant/never-opened contacts to improve sender reputation."]
}`,
      },
      {
        method: "POST",
        path: "/v1/lists/:id/hygiene/suppress",
        summary: "Suppress all contacts in a given health tier (dormant, never_opened, at_risk, or a combo).",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Mailing list ID." }],
        body: [
          { name: "tiers", type: "string[]", required: true, description: "Tiers to suppress: dormant | never_opened | at_risk" },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/lists/lst_abc123/hygiene/suppress \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"tiers": ["dormant", "never_opened"]}'`,
        response: `{ "suppressed": 2140 }`,
      },
    ],
  },
  {
    id: "contacts-patch",
    title: "Contact Management",
    endpoints: [
      {
        method: "GET",
        path: "/v1/contacts",
        summary: "List contacts for a specific mailing list.",
        auth: "apikey",
        params: [
          { name: "list_id", type: "string", required: true, description: "Mailing list ID." },
          { name: "limit", type: "number", description: "Page size (default 50)." },
          { name: "cursor", type: "string", description: "Pagination cursor." },
        ],
      },
      {
        method: "GET",
        path: "/v1/contacts/:email/timeline",
        summary: "Chronological activity log for a single contact — sends, opens, clicks, bounces, list changes, and suppressions.",
        auth: "apikey",
        params: [
          { name: "email", type: "string", required: true, description: "URL-encoded email address." },
          { name: "limit", type: "number", description: "Max events to return (1–100, default 50)." },
        ],
        response: `{
  "email": "alice@example.com",
  "total": 12,
  "events": [
    { "type": "email_opened", "timestamp": "2026-09-01T09:22:00Z", "data": { "send_id": "msg_abc" } },
    { "type": "email_sent", "timestamp": "2026-09-01T08:00:00Z", "data": { "send_id": "msg_abc", "subject": "Welcome!" } }
  ]
}`,
      },
      {
        method: "GET",
        path: "/v1/contacts/:email/engagement",
        summary: "Engagement score (0–100) and tier (highly_engaged / engaged / low_engagement / inactive) for a contact.",
        auth: "apikey",
        params: [{ name: "email", type: "string", required: true, description: "URL-encoded email address." }],
        response: `{ "email": "alice@example.com", "engagement_score": 78, "tier": "highly_engaged" }`,
      },
      {
        method: "PATCH",
        path: "/v1/contacts/:email",
        summary: "Update a contact's name or custom fields. URL-encode the email address.",
        auth: "apikey",
        params: [{ name: "email", type: "string", required: true, description: "URL-encoded email address of the contact." }],
        body: [
          { name: "first_name", type: "string", description: "New first name." },
          { name: "last_name", type: "string", description: "New last name." },
          { name: "custom_fields", type: "object", description: "Arbitrary key-value pairs merged into the contact's custom fields." },
        ],
        example: `curl -X PATCH https://api.continuumapi.com/v1/contacts/alice%40example.com \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "first_name": "Alice",
    "custom_fields": { "plan": "enterprise", "company": "Acme Corp" }
  }'`,
        response: `{
  "id": "con_abc123",
  "email": "alice@example.com",
  "firstName": "Alice",
  "lastName": "Smith",
  "customFields": { "plan": "enterprise", "company": "Acme Corp" },
  "updatedAt": "2026-09-03T10:00:00Z"
}`,
      },
    ],
  },
  {
    id: "domains-dkim",
    title: "Domain DKIM Rotation",
    endpoints: [
      {
        method: "POST",
        path: "/v1/domains/:id/rotate-dkim",
        summary: "Rotate the DKIM keypair for a verified domain. Returns the new DNS record to publish before the old key expires.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Sending domain ID." }],
        response: `{
  "message": "DKIM key rotated. Update the DNS record below within 72 hours.",
  "dkim": {
    "name": "continuumapi-abc._domainkey.mail.acme.com",
    "type": "CNAME",
    "value": "continuumapi-abc.dkim.amazonses.com"
  }
}`,
      },
    ],
  },
  {
    id: "segments",
    title: "Segments",
    endpoints: [
      {
        method: "GET",
        path: "/v1/segments",
        summary: "List all segments with their filter rules.",
        auth: "apikey",
      },
      {
        method: "POST",
        path: "/v1/segments",
        summary: "Create a dynamic segment that filters a list by contact field rules.",
        auth: "apikey",
        body: [
          { name: "name", type: "string", required: true, description: "Segment name." },
          { name: "list_id", type: "string", required: true, description: "Base mailing list to filter." },
          { name: "filter_rules", type: "array", required: true, description: "Array of {field, operator, value} rules. Fields: email | first_name | last_name | custom.<key>. Operators: equals | not_equals | contains | starts_with" },
        ],
        example: `curl -X POST https://api.continuumapi.com/v1/segments \\
  -H "X-API-Key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Enterprise plan users",
    "list_id": "lst_abc123",
    "filter_rules": [
      {"field": "custom.plan", "operator": "equals", "value": "enterprise"}
    ]
  }'`,
        response: `{
  "id": "seg_xyz789",
  "name": "Enterprise plan users",
  "listId": "lst_abc123",
  "filterRules": [{ "field": "custom.plan", "operator": "equals", "value": "enterprise" }],
  "createdAt": "2026-09-03T10:00:00Z"
}`,
      },
      {
        method: "DELETE",
        path: "/v1/segments/:id",
        summary: "Delete a segment. Does not affect the underlying contacts or list.",
        auth: "apikey",
        params: [{ name: "id", type: "string", required: true, description: "Segment ID." }],
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

type Lang = "curl" | "node" | "python";

function EndpointCard({ ep, apiKeyHint }: { ep: EndpointDef; apiKeyHint: string }) {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("curl");

  const exampleWithKey = ep.example?.replace("YOUR_KEY", apiKeyHint || "YOUR_KEY");
  const nodeWithKey = ep.nodeExample?.replace("YOUR_KEY", apiKeyHint || "YOUR_KEY");
  const pythonWithKey = ep.pythonExample?.replace("YOUR_KEY", apiKeyHint || "YOUR_KEY");

  const availableLangs: Lang[] = [
    ...(exampleWithKey ? ["curl" as Lang] : []),
    ...(nodeWithKey ? ["node" as Lang] : []),
    ...(pythonWithKey ? ["python" as Lang] : []),
  ];

  const langLabel: Record<Lang, string> = { curl: "cURL", node: "Node.js", python: "Python" };
  const currentExample = lang === "node" ? nodeWithKey : lang === "python" ? pythonWithKey : exampleWithKey;

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

          {availableLangs.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-0.5 rounded-md border border-border overflow-hidden">
                  {availableLangs.map((l) => (
                    <button
                      key={l}
                      onClick={() => setLang(l)}
                      className={cn(
                        "px-2.5 py-1 text-[11px] font-mono transition-colors",
                        lang === l
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      )}
                    >
                      {langLabel[l]}
                    </button>
                  ))}
                </div>
                <CopyButton text={currentExample ?? ""} />
              </div>
              <pre className="rounded-md bg-[oklch(0.12_0_0)] text-[oklch(0.88_0_0)] text-xs p-4 overflow-x-auto font-mono leading-relaxed">
                <code>{currentExample}</code>
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
