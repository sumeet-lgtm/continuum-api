import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, ShieldOff, Trash2, Search, Download, Upload, X, CheckCircle2, AlertCircle } from "lucide-react";

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

// Keys must match the reason strings the backend actually writes
// (suppress() in routes/send/events.ts, imapWorker.ts's unsubscribe path) —
// these previously didn't ("bounce"/"unsubscribe" vs the real "hard_bounce"/
// "soft_bounce"/"unsubscribed"), so every bounce or unsubscribe suppression
// showed as a raw unstyled reason string instead of a real label.
const REASON_LABELS: Record<string, string> = {
  hard_bounce: "Hard bounce",
  soft_bounce: "Soft bounce (3+)",
  complaint: "Spam complaint",
  manual: "Manually added",
  unsubscribed: "Unsubscribed",
};

function SuppressionsPage() {
  const { primaryKey } = useAuth();
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("manual");
  const [stats, setStats] = useState<{ total: number; byReason: Record<string, number> } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkEmails, setBulkEmails] = useState<string[]>([]);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ added: number; skipped: number; invalid: number } | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    Promise.allSettled([
      api.withKey.get<{ data: Suppression[]; total: number }>("/v1/suppressions?page=1&limit=200", primaryKey.keyRaw),
      api.withKey.get<{ total: number; byReason: Record<string, number> }>("/v1/suppressions/stats", primaryKey.keyRaw),
    ]).then(([listRes, statsRes]) => {
      if (listRes.status === "fulfilled") { setSuppressions(listRes.value.data ?? []); setTotal(listRes.value.total ?? 0); }
      if (statsRes.status === "fulfilled") setStats(statsRes.value);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const filtered = search ? suppressions.filter((s) => s.email.toLowerCase().includes(search.toLowerCase())) : suppressions;

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

  const exportCsv = async () => {
    if (!primaryKey?.keyRaw) return;
    setExporting(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/suppressions/export", {
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `suppressions-${date}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setExporting(false); }
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

  const handleBulkFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const isHeader = (s: string) => /^email/i.test(s.split(",")[0]);
      const parsed = lines.filter((l, i) => !(i === 0 && isHeader(l)))
        .map(l => l.split(",")[0].trim().toLowerCase())
        .filter(e => e.includes("@"));
      setBulkEmails(parsed);
      setBulkResult(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const doBulkImport = async () => {
    if (!primaryKey?.keyRaw || bulkEmails.length === 0) return;
    setBulkImporting(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/suppressions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ emails: bulkEmails }),
      });
      const data = await res.json() as { added: number; skipped: number; invalid: number };
      setBulkResult(data);
      setBulkEmails([]);
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setBulkImporting(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Suppressions</h1>
          <p className="text-sm text-muted-foreground">Emails blocked from receiving any messages — bounces, complaints, and manual blocks.</p>
        </header>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={exportCsv} disabled={exporting || total === 0}>
            <Download className="h-4 w-4" /> {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setBulkOpen(true); setBulkEmails([]); setBulkResult(null); }}>
            <Upload className="h-4 w-4" /> Bulk Import
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add Suppression
          </Button>
        </div>
      </div>

      {/* Reason breakdown stats */}
      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { key: "hard_bounce", label: "Hard bounce" },
            { key: "soft_bounce", label: "Soft bounce" },
            { key: "complaint", label: "Spam complaint" },
            { key: "unsubscribed", label: "Unsubscribed" },
            { key: "manual", label: "Manual" },
          ].map(({ key, label }) => {
            const count = stats.byReason[key] ?? 0;
            const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
            return (
              <div key={key} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground truncate">{label}</p>
                <p className="text-lg font-semibold tabular-nums mt-0.5">{count.toLocaleString()}</p>
                <div className="h-1 rounded-full bg-muted overflow-hidden mt-1.5">
                  <div className="h-full bg-foreground/60 rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{pct.toFixed(0)}%</p>
              </div>
            );
          })}
        </div>
      )}

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
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="text-sm text-muted-foreground tabular-nums">{total.toLocaleString()} total</span>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-3 flex items-center gap-4">
              <div className="h-3 w-44 bg-muted rounded animate-pulse" />
              <div className="h-5 w-20 bg-muted rounded-full animate-pulse" />
              <div className="h-3 w-24 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <ShieldOff className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">{search ? "No results match your search." : "No suppressions yet."}</p>
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
              {filtered.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-mono text-xs">{s.email}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${
                      s.reason === "hard_bounce" || s.reason === "soft_bounce" ? "bg-muted text-[oklch(0.58_0.22_27)]" :
                      s.reason === "complaint" ? "bg-muted text-muted-foreground" :
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
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Bulk Import Suppressions</h2>
              <button onClick={() => setBulkOpen(false)} className="rounded p-1 hover:bg-muted transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {!bulkResult ? (
              <>
                <div className="rounded-lg border-2 border-dashed border-border p-6 text-center space-y-3">
                  <Upload className="h-8 w-8 text-muted-foreground mx-auto" />
                  <div>
                    <p className="text-sm font-medium">Upload a CSV file</p>
                    <p className="text-xs text-muted-foreground mt-1">One email per row, or a CSV with an <code className="text-xs">email</code> column. Up to 5,000 addresses.</p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-muted transition-colors">
                    <Upload className="h-3.5 w-3.5" />
                    Choose file
                    <input type="file" accept=".csv,.txt" className="sr-only" onChange={handleBulkFile} />
                  </label>
                </div>

                {bulkEmails.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1">
                    <p className="text-sm font-medium">{bulkEmails.length.toLocaleString()} valid addresses detected</p>
                    <p className="text-xs text-muted-foreground">Preview: {bulkEmails.slice(0, 3).join(", ")}{bulkEmails.length > 3 ? ` + ${bulkEmails.length - 3} more` : ""}</p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button onClick={doBulkImport} disabled={bulkImporting || bulkEmails.length === 0}>
                    {bulkImporting ? "Importing…" : `Import ${bulkEmails.length > 0 ? bulkEmails.length.toLocaleString() : ""} Addresses`}
                  </Button>
                  <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <CheckCircle2 className="h-5 w-5 text-[oklch(0.55_0.16_145)] mx-auto mb-1" />
                    <p className="text-lg font-semibold tabular-nums">{bulkResult.added.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Added</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <AlertCircle className="h-5 w-5 text-muted-foreground mx-auto mb-1" />
                    <p className="text-lg font-semibold tabular-nums">{bulkResult.skipped.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Already suppressed</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/20 p-3">
                    <X className="h-5 w-5 text-[oklch(0.58_0.22_27)] mx-auto mb-1" />
                    <p className="text-lg font-semibold tabular-nums">{bulkResult.invalid.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Invalid / skipped</p>
                  </div>
                </div>
                <Button className="w-full" onClick={() => setBulkOpen(false)}>Done</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
