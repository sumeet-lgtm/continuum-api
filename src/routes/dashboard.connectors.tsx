import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Copy, Sparkles, ChevronDown, ChevronRight, Plus, Trash2, Eye, EyeOff, Check } from "lucide-react";
import { api } from "@/lib/api";
import { API_BASE } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/dashboard/connectors")({
  head: () => ({ meta: [{ title: "Connectors — Continuum" }] }),
  component: ConnectorsPage,
});

interface Sequence { id: string; name: string; }
interface MailingList { id: string; name: string; }
interface Template { id: string; name: string; }

interface ConnectorRule {
  id: string;
  connector: string;
  event_type: string;
  action: "send_template" | "enroll_sequence";
  template_id?: string | null;
  sequence_id?: string | null;
}

interface ConnectorEvent {
  id: string;
  connector: string;
  event_type: string;
  normalized: { customer_email?: string | null } | null;
  status: string;
  error_msg?: string | null;
  created_at: string;
}

function copy(text: string, label = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast.success(label));
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-muted p-2.5">
        <code className="text-xs font-mono flex-1 break-all">{value}</code>
        <button onClick={() => copy(value)} className="text-muted-foreground hover:text-foreground shrink-0">
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function KeyHeaderNote({ apiKeyPrefix }: { apiKeyPrefix: string | null | undefined }) {
  return (
    <p className="text-xs text-muted-foreground">
      Every request needs your API key as a header —{" "}
      <code className="font-mono">X-API-Key: {apiKeyPrefix ? `${apiKeyPrefix}…` : "your_key"}</code>{" "}
      or <code className="font-mono">Authorization: Bearer …</code>.
    </p>
  );
}

// ─── Payment Connector Events ──────────────────────────────────────────────

const STRIPE_EVENTS = [
  "payment_intent.succeeded", "invoice.paid", "invoice.payment_failed",
  "customer.subscription.created", "customer.subscription.deleted",
  "customer.subscription.updated", "checkout.session.completed",
];
const CHARGEBEE_EVENTS = [
  "payment_succeeded", "payment_failed", "subscription_created",
  "subscription_renewed", "subscription_cancelled", "subscription_reactivated",
];
const RAZORPAY_EVENTS = [
  "payment.captured", "payment.failed", "subscription.activated",
  "subscription.cancelled", "subscription.completed",
];
const PADDLE_EVENTS = [
  "transaction.completed", "transaction.payment_failed",
  "subscription.created", "subscription.cancelled", "subscription.updated",
];
const HUBSPOT_EVENTS = [
  "contact.creation", "contact.propertyChange",
  "deal.creation", "deal.propertyChange", "deal.deletion",
];

const CONNECTOR_META: Record<string, {
  label: string;
  logo: string;
  docs: string;
  events: string[];
  secretLabel: string;
  secretHelp: string;
}> = {
  stripe: {
    label: "Stripe",
    logo: "https://www.google.com/s2/favicons?domain=stripe.com&sz=128",
    docs: "https://dashboard.stripe.com/webhooks",
    events: STRIPE_EVENTS,
    secretLabel: "Webhook signing secret",
    secretHelp: "Found in the Stripe Dashboard → Webhooks → your endpoint → Signing secret",
  },
  chargebee: {
    label: "Chargebee",
    logo: "https://www.google.com/s2/favicons?domain=chargebee.com&sz=128",
    docs: "https://app.chargebee.com/",
    events: CHARGEBEE_EVENTS,
    secretLabel: "Webhook password",
    secretHelp: "Set a password in Chargebee Settings → API & Webhooks → Webhooks",
  },
  razorpay: {
    label: "Razorpay",
    logo: "https://www.google.com/s2/favicons?domain=razorpay.com&sz=128",
    docs: "https://dashboard.razorpay.com/app/webhooks",
    events: RAZORPAY_EVENTS,
    secretLabel: "Webhook secret",
    secretHelp: "Set a secret in Razorpay Dashboard → Account & Settings → Webhooks",
  },
  paddle: {
    label: "Paddle",
    logo: "https://www.google.com/s2/favicons?domain=paddle.com&sz=128",
    docs: "https://vendors.paddle.com/alerts-webhooks",
    events: PADDLE_EVENTS,
    secretLabel: "Webhook secret key",
    secretHelp: "Found in Paddle Dashboard → Developer Tools → Notifications → your endpoint → secret key",
  },
  hubspot: {
    label: "HubSpot",
    logo: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=128",
    docs: "https://developers.hubspot.com/",
    events: HUBSPOT_EVENTS,
    secretLabel: "Client secret",
    secretHelp: "Found in HubSpot → Settings → Account Setup → Integrations → Private Apps → your app",
  },
};

// ─── Integrations Directory ────────────────────────────────────────────────
// Every tool below connects today through one of the mechanisms already built
// on this page — there is no separate bespoke connector per row. We label each
// one honestly rather than implying a dedicated integration exists.

type IntegMethod = "native" | "webhook" | "zapier" | "mcp" | "soon";

const METHOD_META: Record<IntegMethod, { label: string; className: string; help: string }> = {
  native: { label: "Native", className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20", help: "Built-in connector with signing-secret verification and event rules, above." },
  webhook: { label: "Webhook", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20", help: "Point this tool's outbound webhook at the Generic Webhook Intake URL below." },
  zapier: { label: "Zapier / Make / n8n", className: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20", help: "Bridge through Zapier, Make, or n8n into the Generic Webhook Intake URL below — no direct build needed." },
  mcp: { label: "MCP client", className: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20", help: "Connects as an MCP client and calls Continuum's tools directly." },
  soon: { label: "Coming soon", className: "bg-muted text-muted-foreground border-border", help: "On the roadmap — not yet supported." },
};

interface IntegrationTool { name: string; domain: string; method: IntegMethod; }
interface IntegrationCategory { name: string; tools: IntegrationTool[]; }

const INTEGRATIONS: IntegrationCategory[] = [
  {
    name: "CRM",
    tools: [
      { name: "HubSpot", domain: "hubspot.com", method: "native" },
      { name: "Salesforce", domain: "salesforce.com", method: "webhook" },
      { name: "Pipedrive", domain: "pipedrive.com", method: "webhook" },
      { name: "Close", domain: "close.com", method: "webhook" },
      { name: "Attio", domain: "attio.com", method: "webhook" },
      { name: "Zoho CRM", domain: "zoho.com", method: "webhook" },
      { name: "Copper", domain: "copper.com", method: "webhook" },
      { name: "Freshsales", domain: "freshworks.com", method: "webhook" },
      { name: "Microsoft Dynamics 365", domain: "dynamics.microsoft.com", method: "zapier" },
    ],
  },
  {
    name: "Sales engagement & outbound",
    tools: [
      { name: "Clay", domain: "clay.com", method: "native" },
      { name: "Apollo.io", domain: "apollo.io", method: "native" },
      { name: "Outreach", domain: "outreach.io", method: "zapier" },
      { name: "Salesloft", domain: "salesloft.com", method: "zapier" },
      { name: "Instantly", domain: "instantly.ai", method: "zapier" },
      { name: "Smartlead", domain: "smartlead.ai", method: "zapier" },
      { name: "Lemlist", domain: "lemlist.com", method: "zapier" },
      { name: "Woodpecker", domain: "woodpecker.co", method: "zapier" },
      { name: "Reply.io", domain: "reply.io", method: "zapier" },
    ],
  },
  {
    name: "People & company data",
    tools: [
      { name: "ZoomInfo", domain: "zoominfo.com", method: "zapier" },
      { name: "Clearbit", domain: "clearbit.com", method: "zapier" },
      { name: "Lusha", domain: "lusha.com", method: "zapier" },
      { name: "RocketReach", domain: "rocketreach.co", method: "zapier" },
      { name: "Hunter", domain: "hunter.io", method: "zapier" },
      { name: "Crunchbase", domain: "crunchbase.com", method: "zapier" },
      { name: "People Data Labs", domain: "peopledatalabs.com", method: "zapier" },
      { name: "BuiltWith", domain: "builtwith.com", method: "zapier" },
    ],
  },
  {
    name: "Intent data",
    tools: [
      { name: "6sense", domain: "6sense.com", method: "zapier" },
      { name: "Bombora", domain: "bombora.com", method: "zapier" },
      { name: "G2", domain: "g2.com", method: "zapier" },
      { name: "Warmly", domain: "warmly.ai", method: "zapier" },
    ],
  },
  {
    name: "Data warehouses",
    tools: [
      { name: "Snowflake", domain: "snowflake.com", method: "soon" },
      { name: "BigQuery", domain: "cloud.google.com", method: "soon" },
      { name: "Databricks", domain: "databricks.com", method: "soon" },
      { name: "Redshift", domain: "aws.amazon.com", method: "soon" },
    ],
  },
  {
    name: "Payments & billing",
    tools: [
      { name: "Stripe", domain: "stripe.com", method: "native" },
      { name: "Chargebee", domain: "chargebee.com", method: "native" },
      { name: "Razorpay", domain: "razorpay.com", method: "native" },
      { name: "Paddle", domain: "paddle.com", method: "native" },
    ],
  },
  {
    name: "Productivity & collaboration",
    tools: [
      { name: "Slack", domain: "slack.com", method: "zapier" },
      { name: "Notion", domain: "notion.so", method: "webhook" },
      { name: "Airtable", domain: "airtable.com", method: "webhook" },
      { name: "Google Sheets", domain: "google.com", method: "zapier" },
      { name: "Typeform", domain: "typeform.com", method: "webhook" },
      { name: "Calendly", domain: "calendly.com", method: "webhook" },
      { name: "Segment", domain: "segment.com", method: "webhook" },
    ],
  },
  {
    name: "AI & MCP clients",
    tools: [
      { name: "Claude", domain: "claude.ai", method: "mcp" },
      { name: "Cursor", domain: "cursor.com", method: "mcp" },
      { name: "OpenAI", domain: "openai.com", method: "zapier" },
      { name: "Perplexity", domain: "perplexity.ai", method: "zapier" },
    ],
  },
  {
    name: "Support",
    tools: [
      { name: "Zendesk", domain: "zendesk.com", method: "zapier" },
      { name: "Intercom", domain: "intercom.com", method: "zapier" },
      { name: "Freshdesk", domain: "freshworks.com", method: "zapier" },
    ],
  },
];

function IntegrationTile({ tool }: { tool: IntegrationTool }) {
  const meta = METHOD_META[tool.method];
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-2.5" title={meta.help}>
      <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center overflow-hidden shrink-0">
        <img
          src={`https://www.google.com/s2/favicons?domain=${tool.domain}&sz=128`}
          alt=""
          className="h-full w-full object-contain"
          onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{tool.name}</p>
        <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border leading-none ${meta.className}`}>{meta.label}</span>
      </div>
    </div>
  );
}

function IntegrationsDirectory() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">Integrations directory</h2>
        <p className="text-sm text-muted-foreground">
          Every tool here connects today — either as a native connector with rules and an event log (above), through the{" "}
          <a href="#generic-webhook" className="underline underline-offset-2">generic webhook intake</a>, or bridged in via Zapier, Make, or n8n. Nothing below is aspirational without saying so.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(METHOD_META) as IntegMethod[]).map((k) => (
          <span key={k} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border leading-none ${METHOD_META[k].className}`}>
            {METHOD_META[k].label}
          </span>
        ))}
      </div>
      <div className="space-y-6">
        {INTEGRATIONS.map((cat) => (
          <div key={cat.name} className="space-y-2.5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{cat.name}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {cat.tools.map((tool) => <IntegrationTile key={tool.name} tool={tool} />)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PaymentConnectorCard({
  connector,
  apiKey,
  templates,
  sequences,
  allRules,
  allEvents,
  onRulesChange,
}: {
  connector: string;
  apiKey: string;
  templates: Template[];
  sequences: Sequence[];
  allRules: ConnectorRule[];
  allEvents: ConnectorEvent[];
  onRulesChange: (created?: ConnectorRule) => void;
}) {
  const meta = CONNECTOR_META[connector];
  const webhookUrl = `${API_BASE}/v1/connectors/${connector}/webhook`;
  const myRules = allRules.filter((r) => r.connector === connector);
  const myEvents = allEvents.filter((e) => e.connector === connector).slice(0, 5);

  const [secretVal, setSecretVal] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretSaved, setSecretSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [newEvent, setNewEvent] = useState(meta.events[0] ?? "");
  const [newAction, setNewAction] = useState<"send_template" | "enroll_sequence">("send_template");
  const [newTemplateId, setNewTemplateId] = useState("");
  const [newSequenceId, setNewSequenceId] = useState("");
  const [addingRule, setAddingRule] = useState(false);

  const saveSecret = async () => {
    if (!secretVal.trim()) return;
    setSavingSecret(true);
    try {
      await api.withKey.post("/v1/connectors/secrets", { connector, secret: secretVal }, apiKey);
      setSecretSaved(true);
      setSecretVal("");
      toast.success(`${meta.label} secret saved`);
      setTimeout(() => setSecretSaved(false), 2000);
    } catch {
      toast.error("Failed to save secret");
    } finally {
      setSavingSecret(false);
    }
  };

  const addRule = async () => {
    setAddingRule(true);
    try {
      const created = await api.withKey.post<ConnectorRule>("/v1/connectors/rules", {
        connector,
        event_type: newEvent,
        action: newAction,
        template_id: newAction === "send_template" ? (newTemplateId || null) : null,
        sequence_id: newAction === "enroll_sequence" ? (newSequenceId || null) : null,
      }, apiKey);
      toast.success("Rule added");
      onRulesChange(created);
    } catch {
      toast.error("Failed to add rule");
    } finally {
      setAddingRule(false);
    }
  };

  const deleteRule = async (ruleId: string) => {
    try {
      await api.withKey.del(`/v1/connectors/rules/${ruleId}`, apiKey);
      toast.success("Rule removed");
      onRulesChange();
    } catch {
      toast.error("Failed to remove rule");
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center overflow-hidden shrink-0">
          <img src={meta.logo} alt={meta.label} className="h-6 w-6 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{meta.label}</p>
          <p className="text-xs text-muted-foreground">
            {myRules.length > 0 ? `${myRules.length} rule${myRules.length !== 1 ? "s" : ""} active` : "No rules configured"}
          </p>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {/* Webhook URL */}
          <div className="p-4 space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">1. Paste this URL in {meta.label}</h4>
            <UrlRow label={`${meta.label} webhook endpoint`} value={webhookUrl} />
            <p className="text-xs text-muted-foreground">
              → <a href={meta.docs} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:no-underline">Open {meta.label} webhook settings</a>
            </p>
          </div>

          {/* Signing secret */}
          <div className="p-4 space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">2. Save signing secret</h4>
            <p className="text-xs text-muted-foreground">{meta.secretHelp}</p>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>{meta.secretLabel}</Label>
                <div className="relative">
                  <Input
                    type={secretVisible ? "text" : "password"}
                    placeholder="whsec_… or your secret value"
                    value={secretVal}
                    onChange={(e) => setSecretVal(e.target.value)}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setSecretVisible((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {secretVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <Button onClick={saveSecret} disabled={savingSecret || !secretVal.trim()} variant="outline">
                {secretSaved ? <><Check className="h-3.5 w-3.5 mr-1" /> Saved</> : savingSecret ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          {/* Rules */}
          <div className="p-4 space-y-3">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">3. Event rules — when event fires, Continuum does</h4>

            {myRules.length === 0 && (
              <p className="text-xs text-muted-foreground">No rules yet. Add one below.</p>
            )}

            {myRules.map((rule) => (
              <div key={rule.id} className="flex items-center gap-2 text-xs">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{rule.event_type}</code>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium">
                  {rule.action === "send_template"
                    ? `Send template ${templates.find((t) => t.id === rule.template_id)?.name ?? rule.template_id ?? "(any)"}`
                    : `Enroll in ${sequences.find((s) => s.id === rule.sequence_id)?.name ?? rule.sequence_id ?? "(sequence)"}`
                  }
                </span>
                <button onClick={() => deleteRule(rule.id)} className="ml-auto text-muted-foreground hover:text-destructive shrink-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {/* Add rule row */}
            <div className="rounded-md border border-dashed border-border p-3 space-y-2">
              <p className="text-xs font-medium">Add rule</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Event</Label>
                  <Select value={newEvent} onValueChange={setNewEvent}>
                    <SelectTrigger className="h-8 text-xs w-52"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {meta.events.map((e) => <SelectItem key={e} value={e} className="text-xs">{e}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Action</Label>
                  <Select value={newAction} onValueChange={(v) => setNewAction(v as "send_template" | "enroll_sequence")}>
                    <SelectTrigger className="h-8 text-xs w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="send_template" className="text-xs">Send template</SelectItem>
                      <SelectItem value="enroll_sequence" className="text-xs">Enroll in sequence</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {newAction === "send_template" && (
                  <div className="space-y-1">
                    <Label className="text-xs">Template</Label>
                    <Select value={newTemplateId || "__any__"} onValueChange={(v) => setNewTemplateId(v === "__any__" ? "" : v)}>
                      <SelectTrigger className="h-8 text-xs w-44"><SelectValue placeholder="Any template" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__any__" className="text-xs">Any matching template</SelectItem>
                        {templates.map((t) => <SelectItem key={t.id} value={t.id} className="text-xs">{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {newAction === "enroll_sequence" && (
                  <div className="space-y-1">
                    <Label className="text-xs">Sequence</Label>
                    <Select value={newSequenceId} onValueChange={setNewSequenceId}>
                      <SelectTrigger className="h-8 text-xs w-44"><SelectValue placeholder="Pick sequence" /></SelectTrigger>
                      <SelectContent>
                        {sequences.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button size="sm" variant="outline" onClick={addRule} disabled={addingRule}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {addingRule ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          </div>

          {/* Recent events */}
          {myEvents.length > 0 && (
            <div className="p-4 space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent events</h4>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left py-1.5 px-3 text-muted-foreground font-medium">Time</th>
                      <th className="text-left py-1.5 px-3 text-muted-foreground font-medium">Event</th>
                      <th className="text-left py-1.5 px-3 text-muted-foreground font-medium">Email</th>
                      <th className="text-left py-1.5 px-3 text-muted-foreground font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myEvents.map((ev) => (
                      <tr key={ev.id} className="border-t border-border">
                        <td className="py-1.5 px-3 text-muted-foreground font-mono whitespace-nowrap">
                          {new Date(ev.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="py-1.5 px-3"><code className="font-mono">{ev.event_type}</code></td>
                        <td className="py-1.5 px-3 text-muted-foreground">{ev.normalized?.customer_email ?? "—"}</td>
                        <td className="py-1.5 px-3">
                          {ev.status === "ok"
                            ? <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400"><Check className="h-3 w-3" /> OK</span>
                            : <span className="text-destructive">{ev.status === "error" ? "Error" : ev.status}</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

function ConnectorsPage() {
  const { primaryKey } = useAuth();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [rules, setRules] = useState<ConnectorRule[]>([]);
  const [events, setEvents] = useState<ConnectorEvent[]>([]);
  const [sequenceId, setSequenceId] = useState<string>("");
  const [listId, setListId] = useState<string>("");
  const [loadingData, setLoadingData] = useState(true);

  const fetchRulesAndEvents = useCallback(async () => {
    if (!primaryKey?.keyRaw) return;
    const [r, e] = await Promise.all([
      api.withKey.get<{ data: ConnectorRule[] }>("/v1/connectors/rules", primaryKey.keyRaw).catch(() => ({ data: [] })),
      api.withKey.get<{ data: ConnectorEvent[] }>("/v1/connectors/events?limit=50", primaryKey.keyRaw).catch(() => ({ data: [] })),
    ]);
    setRules(r.data ?? []);
    setEvents(e.data ?? []);
  }, [primaryKey]);

  // POST /v1/connectors/rules is an upsert keyed on (connector, event_type) —
  // replace a matching row rather than prepend, so re-saving an existing
  // rule doesn't show a duplicate until the background refetch corrects it.
  const handleRulesChange = useCallback((created?: ConnectorRule) => {
    if (created) {
      setRules((prev) => {
        const idx = prev.findIndex((r) => r.connector === created.connector && r.event_type === created.event_type);
        if (idx === -1) return [created, ...prev];
        const next = [...prev];
        next[idx] = created;
        return next;
      });
    }
    fetchRulesAndEvents();
  }, [fetchRulesAndEvents]);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    setLoadingData(true);
    Promise.all([
      api.withKey.get<{ data: Sequence[] }>("/v1/sequences", primaryKey.keyRaw).then((r) => setSequences(r.data ?? [])).catch(() => {}),
      api.withKey.get<{ lists: MailingList[] }>("/v1/lists", primaryKey.keyRaw).then((r) => setLists(r.lists ?? [])).catch(() => {}),
      api.withKey.get<{ data: Template[] }>("/v1/templates", primaryKey.keyRaw).then((r) => setTemplates(r.data ?? [])).catch(() => {}),
      fetchRulesAndEvents(),
    ]).finally(() => setLoadingData(false));
  }, [primaryKey, fetchRulesAndEvents]);

  const seqParam = sequenceId ? `?sequence_id=${sequenceId}` : "";
  const keyPrefix = primaryKey?.keyPrefix;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Connectors</h1>
        <p className="text-sm text-muted-foreground">
          Connect payment platforms, CRMs, and outbound tools — no code required.
        </p>
      </header>

      {/* ── Payment & CRM Connectors ──────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Payment &amp; CRM</h2>
          <p className="text-sm text-muted-foreground">
            Point your payment platform's webhook at Continuum to send receipts, renewal emails, and cancellation sequences automatically.
          </p>
        </div>
        {loadingData ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-lg border border-border bg-card animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-3">
            {Object.keys(CONNECTOR_META).map((c) => (
              <PaymentConnectorCard
                key={c}
                connector={c}
                apiKey={primaryKey?.keyRaw ?? ""}
                templates={templates}
                sequences={sequences}
                allRules={rules}
                allEvents={events}
                onRulesChange={handleRulesChange}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Outbound Lead Connectors ─────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Outbound &amp; Lead Tools</h2>
          <p className="text-sm text-muted-foreground">
            Clay, Apollo, Zapier/Make/n8n, and MCP clients — push leads or enrich with verification data.
          </p>
        </div>

        {loadingData ? (
          <div className="h-16 rounded-lg border border-border bg-card animate-pulse" />
        ) : sequences.length > 0 && (
          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <label className="text-xs text-muted-foreground shrink-0">Auto-enroll incoming leads into</label>
            <Select value={sequenceId || "__none__"} onValueChange={(v) => setSequenceId(v === "__none__" ? "" : v)}>
              <SelectTrigger className="max-w-[260px]"><SelectValue placeholder="No sequence (just create leads)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No sequence (just create leads)</SelectItem>
                {sequences.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">— this updates the Clay and Apollo URLs below.</p>
          </div>
        )}

        {/* Clay */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div>
            <h3 className="text-sm font-medium">Clay</h3>
            <p className="text-xs text-muted-foreground">Enrich rows with verification data, or push a Clay table export as leads.</p>
          </div>
          <UrlRow label="HTTP Enrichment (GET, per-row)" value={`${API_BASE}/v1/connectors/clay/enrich?email={{email}}`} />
          <UrlRow label="Webhook Intake (POST, table export)" value={`${API_BASE}/v1/connectors/clay/webhook${seqParam}${seqParam ? "&" : "?"}verify=true&skip_invalid=true`} />
          <KeyHeaderNote apiKeyPrefix={keyPrefix} />
        </div>

        {/* Apollo */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div>
            <h3 className="text-sm font-medium">Apollo.io</h3>
            <p className="text-xs text-muted-foreground">Point an Apollo contact export webhook here to land contacts as leads.</p>
          </div>
          <UrlRow label="Webhook Intake (POST)" value={`${API_BASE}/v1/connectors/apollo/webhook${seqParam}`} />
          <KeyHeaderNote apiKeyPrefix={keyPrefix} />
        </div>

        {/* Generic */}
        <div id="generic-webhook" className="rounded-lg border border-border bg-card p-5 space-y-3 scroll-mt-6">
          <div>
            <h3 className="text-sm font-medium">Generic Webhook — Zapier, Make, n8n, or anything else</h3>
            <p className="text-xs text-muted-foreground">Push any JSON payload with your own field mapping.</p>
          </div>
          <UrlRow label="Webhook Intake (POST)" value={`${API_BASE}/v1/connectors/webhook`} />
          {lists.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground shrink-0">Subscribe to list (optional)</label>
              <Select value={listId || "__none__"} onValueChange={(v) => setListId(v === "__none__" ? "" : v)}>
                <SelectTrigger className="max-w-[220px]"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {lists.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground mb-1">Example body</p>
            <div className="flex items-start gap-2 rounded-md bg-muted p-2.5">
              <pre className="text-xs font-mono flex-1 overflow-x-auto">{JSON.stringify({
                rows: [{ Email: "lead@example.com", "First Name": "Jane", Company: "Acme" }],
                field_map: { email: "Email", first_name: "First Name", company: "Company" },
                action: listId ? "subscribe" : "create_lead",
                ...(sequenceId ? { sequence_id: sequenceId } : {}),
                ...(listId ? { list_id: listId } : {}),
              }, null, 2)}</pre>
              <button
                onClick={() => copy(JSON.stringify({
                  rows: [{ Email: "lead@example.com", "First Name": "Jane", Company: "Acme" }],
                  field_map: { email: "Email", first_name: "First Name", company: "Company" },
                  action: listId ? "subscribe" : "create_lead",
                  ...(sequenceId ? { sequence_id: sequenceId } : {}),
                  ...(listId ? { list_id: listId } : {}),
                }, null, 2))}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <KeyHeaderNote apiKeyPrefix={keyPrefix} />
        </div>

        {/* MCP */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">MCP — Claude, Cursor, and other MCP clients</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Use Continuum's verification, sending, and deliverability tools directly as AI tool calls.
          </p>
          <UrlRow label="MCP Server URL" value={`${API_BASE}/mcp`} />
          <KeyHeaderNote apiKeyPrefix={keyPrefix} />
        </div>
      </section>

      <IntegrationsDirectory />
    </div>
  );
}
