import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Upload } from "lucide-react";

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

function LeadsPage() {
  const { primaryKey } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", company: "", title: "" });
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ leads: Lead[]; total: number }>("/v1/leads?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => { setLeads(r.data ?? r.leads ?? []); setTotal(r.total ?? 0); })
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">Cold outreach contacts — separate from newsletter subscribers.</p>
        </header>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5"><Upload className="h-4 w-4" /> Import CSV</Button>
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
                  <td className="px-5 py-3"><StatusBadge status={l.status} /></td>
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
