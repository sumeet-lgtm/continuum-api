import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { API_BASE } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/dashboard/connectors")({
  head: () => ({ meta: [{ title: "Connectors — Continuum API" }] }),
  component: ConnectorsPage,
});

interface Sequence { id: string; name: string; }
interface MailingList { id: string; name: string; }

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
      Every request needs your API key as a header — either{" "}
      <code className="font-mono">X-API-Key: {apiKeyPrefix ? `${apiKeyPrefix}…` : "your_key"}</code> or{" "}
      <code className="font-mono">Authorization: Bearer …</code>. No query-param auth, so header support in the tool you're connecting is required (Clay, Zapier, Make, and n8n all support custom headers).
    </p>
  );
}

function ConnectorsPage() {
  const { primaryKey } = useAuth();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [sequenceId, setSequenceId] = useState<string>("");
  const [listId, setListId] = useState<string>("");

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey.get<{ data: Sequence[] }>("/v1/sequences", primaryKey.keyRaw)
      .then((r) => setSequences(r.data ?? []))
      .catch(() => {});
    api.withKey.get<{ lists: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.lists ?? []))
      .catch(() => {});
  }, [primaryKey]);

  const seqParam = sequenceId ? `?sequence_id=${sequenceId}` : "";
  const keyPrefix = primaryKey?.keyPrefix;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Connectors</h1>
        <p className="text-sm text-muted-foreground">
          Ready-to-paste webhook URLs for Clay, Apollo, Zapier/Make/n8n, and MCP clients — no code required to wire them up.
        </p>
      </header>

      {sequences.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
          <label className="text-xs text-muted-foreground shrink-0">Auto-enroll incoming leads into</label>
          <Select value={sequenceId} onValueChange={setSequenceId}>
            <SelectTrigger className="max-w-[260px]"><SelectValue placeholder="No sequence (just create leads)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">No sequence (just create leads)</SelectItem>
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

      {/* Generic / Zapier / Make / n8n */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-medium">Generic Webhook — Zapier, Make, n8n, or anything else</h3>
          <p className="text-xs text-muted-foreground">Push any JSON payload with your own field mapping. Works as a Zapier "Webhooks by Zapier" POST action.</p>
        </div>
        <UrlRow label="Webhook Intake (POST)" value={`${API_BASE}/v1/connectors/webhook`} />
        {lists.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground shrink-0">List to subscribe to (optional, for action: "subscribe")</label>
            <Select value={listId} onValueChange={setListId}>
              <SelectTrigger className="max-w-[220px]"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
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
          Use Continuum's verification, sending, and deliverability tools directly as AI tool calls. Add this as a Streamable HTTP MCP server.
        </p>
        <UrlRow label="MCP Server URL" value={`${API_BASE}/mcp`} />
        <KeyHeaderNote apiKeyPrefix={keyPrefix} />
      </div>
    </div>
  );
}
