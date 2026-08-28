import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Upload, X, FileText, Loader2 } from "lucide-react";

export const Route = createFileRoute("/dashboard/leads")({
  head: () => ({ meta: [{ title: "Leads — Continuum API" }] }),
  component: LeadsPage,
});

interface Lead {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  status: string;
  createdAt: string;
}

// Parse a CSV string → array of row objects using first row as headers.
// Handles RFC-4180 quoted fields (commas + newlines inside quotes).
function parseCSV(text: string): Record<string, string>[] {
  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === "," && !inQuotes) {
        fields.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  }).filter((r) => r.email);
}

// Map CSV row to lead shape the API expects
function rowToLead(row: Record<string, string>) {
  return {
    email: row.email,
    first_name: row.first_name || row.firstname || row["first name"] || undefined,
    last_name: row.last_name || row.lastname || row["last name"] || undefined,
    company: row.company || row.organization || undefined,
    title: row.title || row.job_title || row["job title"] || undefined,
  };
}

function LeadsPage() {
  const { primaryKey } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", company: "", title: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<Record<string, string>[] | null>(null);
  const [importFile, setImportFile] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ leads: Lead[]; total: number }>("/v1/leads?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => { setLeads(r.leads ?? []); setTotal(r.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const add = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/leads", {
        email: form.email,
        first_name: form.firstName || undefined,
        last_name: form.lastName || undefined,
        company: form.company || undefined,
        title: form.title || undefined,
      }, primaryKey.keyRaw);
      toast.success("Lead added");
      setAdding(false);
      setForm({ email: "", firstName: "", lastName: "", company: "", title: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      setImportPreview(rows);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const runImport = async () => {
    if (!primaryKey?.keyRaw || !importPreview || importPreview.length === 0) return;
    setImporting(true);
    try {
      const leads = importPreview.map(rowToLead);
      // API accepts up to 400 per call — chunk if needed
      const CHUNK = 400;
      let imported = 0;
      for (let i = 0; i < leads.length; i += CHUNK) {
        const chunk = leads.slice(i, i + CHUNK);
        const res = await fetch("https://api.continuumapi.com/v1/leads/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
          body: JSON.stringify({ leads: chunk }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
        }
        const json = await res.json().catch(() => ({ imported: 0 }));
        imported += (json as { imported?: number }).imported ?? 0;
      }
      toast.success(`${imported.toLocaleString()} leads imported`);
      setImportPreview(null);
      setImportFile("");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">Cold outreach contacts — separate from newsletter subscribers.</p>
        </header>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileSelect} />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Import CSV
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add Lead</Button>
        </div>
      </div>

      {adding && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-lg">
          <h2 className="text-sm font-semibold">Add Lead</h2>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input placeholder="cto@company.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First name</Label>
              <Input placeholder="John" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input placeholder="Doe" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Input placeholder="Acme Corp" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input placeholder="CTO" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Lead"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{importFile}</p>
                <p className="text-xs text-muted-foreground">{importPreview.length.toLocaleString()} leads found</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setImportPreview(null); setImportFile(""); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground border-b border-border">
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Company</th>
                  <th className="px-3 py-2 text-left font-medium">Title</th>
                </tr>
              </thead>
              <tbody>
                {importPreview.slice(0, 5).map((row, i) => {
                  const l = rowToLead(row);
                  return (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5 font-mono">{l.email}</td>
                      <td className="px-3 py-1.5">{[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{l.company ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{l.title ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {importPreview.length > 5 && (
              <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
                + {(importPreview.length - 5).toLocaleString()} more rows
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Expected columns: <code className="bg-muted rounded px-1">email</code>, <code className="bg-muted rounded px-1">first_name</code>, <code className="bg-muted rounded px-1">last_name</code>, <code className="bg-muted rounded px-1">company</code>, <code className="bg-muted rounded px-1">title</code>
          </p>
          <div className="flex gap-2">
            <Button onClick={runImport} disabled={importing} className="gap-1.5">
              {importing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…</> : <><Upload className="h-3.5 w-3.5" /> Import {importPreview.length.toLocaleString()} Leads</>}
            </Button>
            <Button variant="outline" onClick={() => { setImportPreview(null); setImportFile(""); }}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">Total leads:</span>
        <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No leads yet. Add individually or import a CSV.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Company</th>
                <th className="px-5 py-3 font-medium">Title</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-mono text-xs">{l.email}</td>
                  <td className="px-5 py-3">{[l.firstName, l.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td className="px-5 py-3 text-muted-foreground">{l.company ?? "—"}</td>
                  <td className="px-5 py-3 text-muted-foreground">{l.title ?? "—"}</td>
                  <td className="px-5 py-3">
                  <select
                    className="rounded border border-input bg-background px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={l.status}
                    onChange={async (e) => {
                      const newStatus = e.target.value;
                      const prevStatus = l.status;
                      if (!primaryKey?.keyRaw) return;
                      setLeads((prev) => prev.map((x) => x.id === l.id ? { ...x, status: newStatus } : x));
                      try {
                        const res = await fetch(`https://api.continuumapi.com/v1/leads/${l.id}/status`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
                          body: JSON.stringify({ status: newStatus }),
                        });
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}));
                          throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
                        }
                      } catch (e: unknown) {
                        setLeads((prev) => prev.map((x) => x.id === l.id ? { ...x, status: prevStatus } : x));
                        toast.error((e as Error).message);
                      }
                    }}
                  >
                    {["active","interested","not_interested","replied","unsubscribed","bounced","do_not_contact"].map((s) => (
                      <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </td>
                  <td className="px-5 py-3 text-muted-foreground">{new Date(l.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
