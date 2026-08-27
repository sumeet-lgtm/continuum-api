import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, ShieldOff, Trash2, Search } from "lucide-react";

export const Route = createFileRoute("/dashboard/suppressions")({
  head: () => ({ meta: [{ title: "Suppressions — Continuum API" }] }),
  component: SuppressionsPage,
});

interface Suppression {
  id: string;
  email: string;
  reason: string;
  createdAt: string;
}

const REASON_LABELS: Record<string, string> = {
  bounce: "Hard bounce",
  complaint: "Spam complaint",
  manual: "Manually added",
  unsubscribe: "Unsubscribed",
};

function SuppressionsPage() {
  const { primaryKey } = useAuth();
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("manual");

  const load = (q = search) => {
    if (!primaryKey?.keyRaw) return;
    const params = new URLSearchParams({ page: "1", limit: "100" });
    if (q) params.set("email", q);
    api.withKey
      .get<{ data: Suppression[]; total: number }>(`/v1/suppressions?${params}`, primaryKey.keyRaw)
      .then((r) => { setSuppressions(r.data ?? []); setTotal(r.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const add = async () => {
    if (!primaryKey?.keyRaw || !email.trim()) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/suppressions", { email: email.trim(), reason }, primaryKey.keyRaw);
      toast.success(`${email} added to suppression list`);
      setAdding(false);
      setEmail("");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const remove = async (email: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/suppressions/${encodeURIComponent(email)}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      setSuppressions((s) => s.filter((x) => x.email !== email));
      setTotal((t) => Math.max(0, t - 1));
      toast.success("Removed from suppression list");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Suppressions</h1>
          <p className="text-sm text-muted-foreground">Emails blocked from receiving any messages — bounces, complaints, and manual blocks.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add Suppression
        </Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">Add to Suppression List</h2>
          <div className="space-y-1.5">
            <Label>Email address</Label>
            <Input
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="manual">Manual block</option>
              <option value="bounce">Hard bounce</option>
              <option value="complaint">Spam complaint</option>
              <option value="unsubscribe">Unsubscribed</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Suppression"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by email…"
            className="pl-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); load(e.target.value); }}
          />
        </div>
        <span className="text-sm text-muted-foreground tabular-nums">{total.toLocaleString()} total</span>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : suppressions.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <ShieldOff className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No suppressions yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Emails are auto-added here on hard bounce or spam complaint. You can also add manually.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Reason</th>
                <th className="px-5 py-3 font-medium">Added</th>
                <th className="px-5 py-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-mono text-xs">{s.email}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${
                      s.reason === "bounce" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                      s.reason === "complaint" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" :
                      "bg-muted text-muted-foreground"
                    }`}>
                      {REASON_LABELS[s.reason] ?? s.reason}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground text-xs">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => remove(s.email)}
                      title="Remove from suppression list"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
