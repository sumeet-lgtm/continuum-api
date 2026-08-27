import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Check, Eye, EyeOff, Plus, Trash2, KeyRound, ShieldCheck, Shield } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";

export const Route = createFileRoute("/dashboard/api-keys")({
  head: () => ({ meta: [{ title: "API Keys — Continuum API" }] }),
  component: ApiKeysPage,
});

interface NewKey {
  id: string;
  name: string;
  keyRaw: string;
  permission: string;
}

function MaskedKey({ prefix, raw }: { prefix: string; raw: string | null }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const val = raw ?? prefix;
    await navigator.clipboard.writeText(val);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2 mt-1.5">
      <code className="flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
        {revealed && raw ? raw : `${prefix}${"•".repeat(20)}`}
      </code>
      {raw && (
        <Button variant="outline" size="sm" onClick={() => setRevealed((v) => !v)}>
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          <span className="ml-1.5">{revealed ? "Hide" : "Show"}</span>
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onCopy}>
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
        <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

function ApiKeysPage() {
  const { apiKeys, primaryKey, refreshMe } = useAuth();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", permission: "full_access" });
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState<NewKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const create = async () => {
    if (!primaryKey?.keyRaw || !form.name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ name: form.name.trim(), permission: form.permission }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Failed to create key");
      }
      const data = await res.json();
      setNewKey({
        id: data.id ?? data.apiKey?.id,
        name: form.name.trim(),
        keyRaw: data.keyRaw ?? data.apiKey?.keyRaw ?? data.key,
        permission: form.permission,
      });
      setCreating(false);
      setForm({ name: "", permission: "full_access" });
      await refreshMe();
      toast.success("API key created");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: string, name: string) => {
    if (!primaryKey?.keyRaw || !confirm(`Revoke key "${name}"? Any requests using it will fail immediately.`)) return;
    setRevoking(id);
    try {
      await fetch(`https://api.continuumapi.com/v1/api-keys/${id}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      await refreshMe();
      if (newKey?.id === id) setNewKey(null);
      toast.success("Key revoked");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  const PERM_LABEL: Record<string, string> = {
    full_access: "Full access",
    sending_access: "Sending only",
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">
            Authenticate requests to the Continuum API. Create scoped keys for different services.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => { setCreating(true); setNewKey(null); }}>
          <Plus className="h-4 w-4" /> Create Key
        </Button>
      </header>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">New API Key</h2>
          <div className="space-y-1.5">
            <Label>Key name</Label>
            <Input
              placeholder="e.g. Production server, Campaign sender"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") create(); }}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Permission scope</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.permission}
              onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value }))}
            >
              <option value="full_access">Full access — verify, send, campaigns, sequences, analytics</option>
              <option value="sending_access">Sending only — transactional send, campaigns (no verify, no analytics)</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving || !form.name.trim()}>
              {saving ? "Creating…" : "Create Key"}
            </Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {newKey && (
        <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 p-5 space-y-3 max-w-2xl">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
            <ShieldCheck className="h-4 w-4" />
            <p className="text-sm font-medium">Key created — copy it now. You won't be able to see it again.</p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">"{newKey.name}"</label>
            <MaskedKey prefix={newKey.keyRaw.slice(0, 8)} raw={newKey.keyRaw} />
          </div>
        </div>
      )}

      {apiKeys.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <KeyRound className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No API keys yet. Create one to start making requests.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-muted/40">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {apiKeys.length} key{apiKeys.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="divide-y divide-border">
            {apiKeys.map((k) => (
              <div key={k.id} className="px-5 py-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{k.name ?? k.label ?? "Default key"}</p>
                      <StatusBadge status="active" />
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        <Shield className="h-3 w-3" />
                        {PERM_LABEL[k.permission] ?? k.permission}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                      {k.plan ? ` · ${k.plan} plan` : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive shrink-0"
                    onClick={() => revoke(k.id, k.name ?? k.label ?? "this key")}
                    disabled={revoking === k.id}
                    title="Revoke key"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Key</label>
                  <MaskedKey prefix={k.keyPrefix ?? "cnt_"} raw={k.keyRaw} />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {k.currentMonthUsage.toLocaleString()} API calls this month
                    {k.monthlyLimit ? ` / ${k.monthlyLimit.toLocaleString()} limit` : ""}
                    {k.currentMonthSendUsage > 0
                      ? ` · ${k.currentMonthSendUsage.toLocaleString()} emails sent`
                      : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-5">
        <h3 className="text-sm font-medium mb-2">Quick reference</h3>
        <p className="text-xs text-muted-foreground mb-3">Pass your API key in the <code className="bg-muted rounded px-1">X-API-Key</code> header or as Bearer token:</p>
        <code className="block bg-muted rounded-md p-3 text-xs font-mono whitespace-pre overflow-x-auto">
          {`curl https://api.continuumapi.com/v1/send \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":["user@example.com"],"from":"hello@yourdomain.com","subject":"Hello","html_body":"<p>Hi!</p>"}'`}
        </code>
      </div>
    </div>
  );
}
