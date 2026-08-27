import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Send, Zap, TestTube } from "lucide-react";

export const Route = createFileRoute("/dashboard/mailboxes")({
  head: () => ({ meta: [{ title: "Mailboxes — Continuum API" }] }),
  component: MailboxesPage,
});

interface Mailbox {
  id: string;
  type: string;
  username: string;
  dailyLimit: number;
  sentToday: number;
  status: string;
  lastCheckedAt: string | null;
  warmupConfig?: { enabled: boolean; currentPerDay: number; targetPerDay: number } | null;
}

function MailboxesPage() {
  const { primaryKey } = useAuth();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: "smtp", host: "", port: "587", username: "", password: "", dailyLimit: "100" });
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ mailboxes: Mailbox[] }>("/v1/mailboxes", primaryKey.keyRaw)
      .then((r) => setMailboxes(r.mailboxes ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const add = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/mailboxes", {
        type: form.type,
        host: form.host || undefined,
        port: form.port ? parseInt(form.port) : undefined,
        username: form.username,
        password: form.password || undefined,
        daily_limit: parseInt(form.dailyLimit),
      }, primaryKey.keyRaw);
      toast.success("Mailbox connected");
      setAdding(false);
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const test = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.post(`/v1/mailboxes/${id}/test`, {}, primaryKey.keyRaw);
      toast.success("Test email sent successfully");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Mailboxes</h1>
          <p className="text-sm text-muted-foreground">Connect SMTP or OAuth mailboxes for multi-mailbox rotation in sequences.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Connect Mailbox
        </Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-lg">
          <h2 className="text-sm font-semibold">Connect SMTP Mailbox</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>SMTP Host</Label>
              <Input placeholder="smtp.gmail.com" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <Input placeholder="587" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email (username)</Label>
            <Input placeholder="you@company.com" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>App Password</Label>
            <Input type="password" placeholder="••••••••••••" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Daily sending limit</Label>
            <Input type="number" placeholder="100" value={form.dailyLimit} onChange={(e) => setForm((f) => ({ ...f, dailyLimit: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Connecting…" : "Connect Mailbox"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : mailboxes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Send className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-2">No mailboxes connected yet.</p>
          <p className="text-xs text-muted-foreground">Connect SMTP, Gmail, or Outlook mailboxes for multi-mailbox rotation in sequences.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {mailboxes.map((m) => (
            <div key={m.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Send className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{m.username}</div>
                    <div className="text-xs text-muted-foreground capitalize">{m.type} · {m.sentToday}/{m.dailyLimit} today</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={m.status} />
                  {m.warmupConfig?.enabled && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Zap className="h-3 w-3" /> Warmup {m.warmupConfig.currentPerDay}/{m.warmupConfig.targetPerDay}/day
                    </span>
                  )}
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => test(m.id)}>
                    <TestTube className="h-3 w-3" /> Test
                  </Button>
                </div>
              </div>
              <div className="mt-3 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-foreground transition-all"
                  style={{ width: `${Math.min(100, (m.sentToday / m.dailyLimit) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
