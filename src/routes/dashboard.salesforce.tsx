import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Cloud, CheckCircle2, XCircle, RefreshCw, Unplug, AlertTriangle, Plus, X } from "lucide-react";

export const Route = createFileRoute("/dashboard/salesforce")({
  head: () => ({ meta: [{ title: "Salesforce — Continuum" }] }),
  component: SalesforcePage,
});

interface ConnectionStatus {
  connected: boolean;
  instanceUrl?: string;
  connectedEmail?: string | null;
  syncEnabled?: boolean;
  lastPushedAt?: string | null;
  lastPulledAt?: string | null;
  lastErrorMsg?: string | null;
  syncedLeadCount?: number;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_code: "That connection attempt didn't complete — try again.",
  invalid_or_expired_state: "That connection attempt expired — try connecting again.",
  connect_failed: "Couldn't finish connecting to Salesforce. Try again.",
};

type BuiltinSource = "firstName" | "lastName" | "company" | "title" | "tags";
const BUILTIN_SOURCES: { value: BuiltinSource; label: string }[] = [
  { value: "firstName", label: "First Name" },
  { value: "lastName", label: "Last Name" },
  { value: "company", label: "Company" },
  { value: "title", label: "Title" },
  { value: "tags", label: "Tags" },
];

interface FieldMapping { source: string; target: string }

// One editable row — mirrors a FieldMapping, but keeps "which of our fields"
// and "which custom variable key" as separate UI state so a custom-variable
// row can have its key edited without re-parsing the "customVars.<key>"
// string on every keystroke.
interface MappingRow {
  kind: BuiltinSource | "customVar";
  customVarKey: string;
  target: string;
}

function rowToMapping(row: MappingRow): FieldMapping | null {
  const target = row.target.trim();
  if (!target) return null;
  if (row.kind === "customVar") {
    const key = row.customVarKey.trim();
    if (!key) return null;
    return { source: `customVars.${key}`, target };
  }
  return { source: row.kind, target };
}

function mappingToRow(m: FieldMapping): MappingRow {
  if (m.source.startsWith("customVars.")) {
    return { kind: "customVar", customVarKey: m.source.slice("customVars.".length), target: m.target };
  }
  return { kind: m.source as BuiltinSource, customVarKey: "", target: m.target };
}

function SalesforcePage() {
  const { primaryKey } = useAuth();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([]);
  const [savingMappings, setSavingMappings] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<ConnectionStatus>("/v1/connectors/salesforce", primaryKey.keyRaw)
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const loadMappings = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ field_mappings: FieldMapping[] }>("/v1/connectors/salesforce/field-mapping", primaryKey.keyRaw)
      .then((res) => setMappingRows(res.field_mappings.map(mappingToRow)))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [primaryKey]);
  useEffect(() => {
    if (status?.connected) loadMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected]);

  const addMappingRow = () => setMappingRows((rows) => [...rows, { kind: "title", customVarKey: "", target: "" }]);
  const removeMappingRow = (i: number) => setMappingRows((rows) => rows.filter((_, idx) => idx !== i));
  const updateMappingRow = (i: number, patch: Partial<MappingRow>) =>
    setMappingRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const saveMappings = async () => {
    if (!primaryKey?.keyRaw) return;
    const mappings = mappingRows.map(rowToMapping).filter((m): m is FieldMapping => m !== null);
    setSavingMappings(true);
    try {
      await api.withKey.put("/v1/connectors/salesforce/field-mapping", { field_mappings: mappings }, primaryKey.keyRaw);
      toast.success("Field mapping saved.");
    } catch {
      toast.error("Couldn't save field mapping.");
    } finally {
      setSavingMappings(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("oauth_error");
    if (connected === "salesforce") {
      toast.success("Salesforce connected — the first sync runs within the hour.");
      load();
    } else if (oauthError) {
      toast.error(OAUTH_ERROR_MESSAGES[oauthError] ?? "Salesforce connection failed.");
    }
    if (connected || oauthError) window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    if (!primaryKey?.keyRaw) return;
    setConnecting(true);
    try {
      const res = await api.withKey.get<{ url: string }>("/v1/connectors/salesforce/oauth/start", primaryKey.keyRaw);
      window.location.href = res.url;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the Salesforce connection.");
      setConnecting(false);
    }
  };

  const toggleSync = async (enabled: boolean) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.patch("/v1/connectors/salesforce", { sync_enabled: enabled }, primaryKey.keyRaw);
      setStatus((prev) => (prev ? { ...prev, syncEnabled: enabled } : prev));
      toast.success(enabled ? "Sync resumed." : "Sync paused.");
    } catch {
      toast.error("Couldn't update sync setting.");
    }
  };

  const testNow = async () => {
    if (!primaryKey?.keyRaw) return;
    setTesting(true);
    try {
      const res = await api.withKey.post<{ ok: boolean; error?: string }>("/v1/connectors/salesforce/test", {}, primaryKey.keyRaw);
      if (res.ok) toast.success("Connection is healthy.");
      else toast.error(res.error ?? "Connection test failed.");
      load();
    } catch {
      toast.error("Connection test failed.");
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!confirm("Disconnect Salesforce? Sync will stop until you reconnect.")) return;
    setDisconnecting(true);
    try {
      await api.withKey.del("/v1/connectors/salesforce", primaryKey.keyRaw);
      setStatus({ connected: false });
      toast.success("Salesforce disconnected.");
    } catch {
      toast.error("Couldn't disconnect.");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Salesforce</h1>
        <p className="text-sm text-muted-foreground">
          Two-way sync — verified leads push in as Salesforce Leads, replies log as activity, and status changes
          made in Salesforce (unqualified, converted) pause the matching Continuum sequence automatically.
        </p>
      </header>

      {loading ? (
        <div className="h-40 rounded-lg border border-border bg-card animate-pulse" />
      ) : !status?.connected ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-4">
          <Cloud className="h-8 w-8 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium">Not connected</p>
            <p className="text-xs text-muted-foreground mt-1">Connect your Salesforce org to start syncing leads both ways.</p>
          </div>
          <Button onClick={connect} disabled={connecting} className="gap-1.5">
            <Cloud className="h-4 w-4" />
            {connecting ? "Redirecting…" : "Connect Salesforce"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)]" />
                <span className="text-sm font-medium">Connected</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sync {status.syncEnabled ? "on" : "paused"}</span>
                <Switch checked={!!status.syncEnabled} onCheckedChange={toggleSync} />
              </div>
            </div>

            {status.lastErrorMsg && (
              <div className="rounded-md border border-[oklch(0.85_0.12_27)] bg-[oklch(0.98_0.02_27)] p-3 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-[oklch(0.58_0.22_27)] shrink-0 mt-0.5" />
                <p className="text-xs text-[oklch(0.42_0.18_27)]">{status.lastErrorMsg}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground">Org</p>
                <p className="font-mono truncate">{status.instanceUrl?.replace(/^https?:\/\//, "")}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Connected as</p>
                <p className="truncate">{status.connectedEmail ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Leads synced</p>
                <p className="font-medium tabular-nums">{status.syncedLeadCount ?? 0}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last sync</p>
                <p>{relativeTime(status.lastPushedAt)}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={testNow} disabled={testing}>
                <RefreshCw className={`h-3.5 w-3.5 ${testing ? "animate-spin" : ""}`} />
                Test connection
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 text-destructive ml-auto" onClick={disconnect} disabled={disconnecting}>
                <Unplug className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">What syncs, and when</p>
            <p>Runs hourly. New and updated leads push out as Salesforce Leads (matched by email — never duplicated). Replies log as completed Tasks on the matching record. If a rep marks a lead Unqualified, Disqualified, or Converted in Salesforce, the matching Continuum sequence pauses automatically.</p>
          </div>

          <div className="rounded-lg border border-border bg-card p-6 space-y-4">
            <div>
              <p className="text-sm font-medium">Field mapping</p>
              <p className="text-xs text-muted-foreground mt-1">
                Your org's Lead layout won't always match our standard fields exactly. Map any of ours to whatever
                field actually holds that data on your side — including a custom field (these usually end in{" "}
                <code className="font-mono text-[11px]">__c</code>).
              </p>
            </div>

            {mappingRows.length > 0 && (
              <div className="space-y-2">
                {mappingRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select value={row.kind} onValueChange={(v) => updateMappingRow(i, { kind: v as MappingRow["kind"] })}>
                      <SelectTrigger className="w-40 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BUILTIN_SOURCES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                        <SelectItem value="customVar">Custom variable…</SelectItem>
                      </SelectContent>
                    </Select>

                    {row.kind === "customVar" && (
                      <Input
                        placeholder="variable key"
                        value={row.customVarKey}
                        onChange={(e) => updateMappingRow(i, { customVarKey: e.target.value })}
                        className="w-36 shrink-0 font-mono text-xs"
                      />
                    )}

                    <span className="text-xs text-muted-foreground shrink-0">→</span>

                    <Input
                      placeholder="Salesforce field API name, e.g. Job_Title__c"
                      value={row.target}
                      onChange={(e) => updateMappingRow(i, { target: e.target.value })}
                      className="flex-1 font-mono text-xs"
                    />

                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeMappingRow(i)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={addMappingRow}>
                <Plus className="h-3.5 w-3.5" />
                Add mapping
              </Button>
              <Button size="sm" className="ml-auto" onClick={saveMappings} disabled={savingMappings}>
                {savingMappings ? "Saving…" : "Save mapping"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
