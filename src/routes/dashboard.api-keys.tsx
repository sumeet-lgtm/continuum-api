import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Check, Eye, EyeOff, Plus, Trash2, KeyRound, ShieldCheck, Shield, Globe, ChevronDown, ChevronUp, X, Pencil } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
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
        {copied ? <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3.5 w-3.5" />}
        <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

function IpAllowlistPanel({
  keyId,
  currentIps,
  apiKeyRaw,
  onUpdated,
}: {
  keyId: string;
  currentIps: string[];
  apiKeyRaw: string;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [ips, setIps] = useState<string[]>(currentIps);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const addIp = () => {
    const trimmed = input.trim();
    if (!trimmed || ips.includes(trimmed)) return;
    setIps((prev) => [...prev, trimmed]);
    setInput("");
  };

  const removeIp = (ip: string) => setIps((prev) => prev.filter((x) => x !== ip));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/api-keys/${keyId}/ip-allowlist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKeyRaw },
        body: JSON.stringify({ ips }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Failed to update");
      }
      toast.success(ips.length === 0 ? "IP allowlist cleared" : `Allowlist updated (${ips.length} IP${ips.length !== 1 ? "s" : ""})`);
      onUpdated();
      setOpen(false);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border rounded-md">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/30 rounded-md transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <Globe className="h-3 w-3" />
          IP Allowlist
          {currentIps.length > 0 && (
            <span className="ml-1 rounded-full bg-foreground text-background px-1.5 py-0.5 text-[10px] font-medium leading-none">
              {currentIps.length}
            </span>
          )}
        </span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border mt-0 pt-3">
          <p className="text-xs text-muted-foreground">
            Restrict this key to specific IP addresses or CIDR ranges. Leave empty to allow all IPs.
          </p>

          {ips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ips.map((ip) => (
                <span key={ip} className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-mono">
                  {ip}
                  <button onClick={() => removeIp(ip)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              className="h-7 text-xs font-mono"
              placeholder="192.168.1.0/24 or 203.0.113.5"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addIp(); }}
            />
            <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={addIp}>Add</Button>
          </div>

          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setIps(currentIps); setOpen(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpiryPanel({
  keyId,
  currentExpiry,
  apiKeyRaw,
  onUpdated,
}: {
  keyId: string;
  currentExpiry: string | null | undefined;
  apiKeyRaw: string;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(
    currentExpiry ? new Date(currentExpiry).toISOString().slice(0, 16) : ""
  );
  const [saving, setSaving] = useState(false);

  const save = async (clear = false) => {
    setSaving(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/api-keys/${keyId}/expiry`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKeyRaw },
        body: JSON.stringify({ expiresAt: clear ? null : new Date(value).toISOString() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Failed");
      }
      toast.success(clear ? "Expiry cleared" : "Expiry set");
      onUpdated();
      setOpen(false);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const expLabel = currentExpiry
    ? new Date(currentExpiry) <= new Date()
      ? "Expired"
      : `Expires ${new Date(currentExpiry).toLocaleDateString()}`
    : "Never expires";

  return (
    <div className="border border-border rounded-md">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/30 rounded-md transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <Shield className="h-3 w-3" />
          Key expiry · {expLabel}
        </span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            Set an expiry date to automatically prevent this key from being used after the specified time.
          </p>
          <Input
            type="datetime-local"
            className="h-7 text-xs"
            value={value}
            min={new Date().toISOString().slice(0, 16)}
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={() => save()} disabled={saving || !value}>
              {saving ? "Saving…" : "Set expiry"}
            </Button>
            {currentExpiry && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => save(true)} disabled={saving}>
                Clear
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function UsageAlertToggle({
  keyId,
  enabled,
  apiKeyRaw,
}: {
  keyId: string;
  enabled: boolean;
  apiKeyRaw: string;
}) {
  const [on, setOn] = useState(enabled);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    const next = !on;
    setSaving(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/api-keys/${keyId}/usage-alerts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKeyRaw },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error("Failed to update");
      setOn(next);
      toast.success(next ? "Usage alerts enabled" : "Usage alerts disabled");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={saving}
      className="flex items-center justify-between w-full rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
    >
      <span className="flex items-center gap-1.5">
        <ShieldCheck className="h-3 w-3" />
        Email alert at 80% quota
      </span>
      <span
        className={`inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          on ? "bg-foreground" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-background transition-transform mx-0.5 ${
            on ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function InlineRename({
  keyId,
  currentLabel,
  apiKeyRaw,
  onRenamed,
}: {
  keyId: string;
  currentLabel: string;
  apiKeyRaw: string;
  onRenamed: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentLabel);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!value.trim() || value.trim() === currentLabel) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/api-keys/${keyId}/label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKeyRaw },
        body: JSON.stringify({ label: value.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? "Failed");
      }
      onRenamed(value.trim());
      setEditing(false);
      toast.success("Key renamed");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          className="h-6 text-sm py-0 px-2 w-44"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setValue(currentLabel); setEditing(false); } }}
        />
        <Button size="sm" className="h-6 text-xs px-2" onClick={save} disabled={saving || !value.trim()}>
          {saving ? "…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => { setValue(currentLabel); setEditing(false); }}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <button
      className="group flex items-center gap-1 text-sm font-medium hover:text-muted-foreground transition-colors"
      onClick={() => setEditing(true)}
      title="Rename key"
    >
      {currentLabel}
      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
    </button>
  );
}

function ApiKeysPage() {
  const { apiKeys, primaryKey, refreshMe } = useAuth();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", permission: "full_access" });
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState<NewKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [keyLabels, setKeyLabels] = useState<Record<string, string>>({});

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
          <h1 className="text-2xl font-display font-medium tracking-tight">API Keys</h1>
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
        <div className="rounded-lg border border-border bg-muted/60 p-5 space-y-3 max-w-2xl">
          <div className="flex items-center gap-2 text-[oklch(0.55_0.16_145)]">
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
                      {primaryKey?.keyRaw ? (
                        <InlineRename
                          keyId={k.id}
                          currentLabel={keyLabels[k.id] ?? k.label ?? k.name ?? "Default key"}
                          apiKeyRaw={primaryKey.keyRaw}
                          onRenamed={(label) => setKeyLabels((prev) => ({ ...prev, [k.id]: label }))}
                        />
                      ) : (
                        <p className="text-sm font-medium">{k.name ?? k.label ?? "Default key"}</p>
                      )}
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
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {(k.currentMonthUsage ?? 0).toLocaleString()} verifications this month
                      {k.monthlyLimit ? ` / ${k.monthlyLimit.toLocaleString()} limit` : ""}
                    </p>
                    {(k.currentMonthSendUsage ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {(k.currentMonthSendUsage ?? 0).toLocaleString()} emails sent
                      </p>
                    )}
                    {(k as { rateLimit?: number }).rateLimit && (
                      <p className="text-xs text-muted-foreground">
                        {(k as { rateLimit?: number }).rateLimit?.toLocaleString()} req/min rate limit
                      </p>
                    )}
                  </div>
                </div>
                {primaryKey?.keyRaw && (
                  <div className="flex flex-col gap-2">
                    <IpAllowlistPanel
                      keyId={k.id}
                      currentIps={(k as { allowedIps?: string[] }).allowedIps ?? []}
                      apiKeyRaw={primaryKey.keyRaw}
                      onUpdated={refreshMe}
                    />
                    <ExpiryPanel
                      keyId={k.id}
                      currentExpiry={(k as { expiresAt?: string | null }).expiresAt}
                      apiKeyRaw={primaryKey.keyRaw}
                      onUpdated={refreshMe}
                    />
                    <UsageAlertToggle
                      keyId={k.id}
                      enabled={(k as { usageAlertEnabled?: boolean }).usageAlertEnabled !== false}
                      apiKeyRaw={primaryKey.keyRaw}
                    />
                  </div>
                )}
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
