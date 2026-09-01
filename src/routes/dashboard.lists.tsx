import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Users, Trash2 } from "lucide-react";

export const Route = createFileRoute("/dashboard/lists")({
  head: () => ({ meta: [{ title: "Mailing Lists — Continuum API" }] }),
  component: ListsPage,
});

interface MailingList { id: string; name: string; description: string | null; contactCount: number; createdAt: string; }

function ListsPage() {
  const { primaryKey } = useAuth();
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/lists", { name: form.name, description: form.description || undefined }, primaryKey.keyRaw);
      toast.success("List created");
      setCreating(false);
      setForm({ name: "", description: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const remove = async (l: MailingList) => {
    if (!primaryKey?.keyRaw) return;
    if (!confirm(`Delete list "${l.name}"? This cannot be undone.`)) return;
    try {
      await api.withKey.del(`/v1/lists/${l.id}`, primaryKey.keyRaw);
      toast.success("List deleted");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Mailing Lists</h1>
          <p className="text-sm text-muted-foreground">Manage opt-in subscriber lists for campaigns.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New List
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">New Mailing List</h2>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="Newsletter subscribers" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input placeholder="Weekly product updates" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create List"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : lists.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No mailing lists yet. Create a list, then import your subscribers.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {lists.map((l) => (
            <div key={l.id} className="rounded-lg border border-border bg-card p-5 space-y-3">
              <div>
                <h2 className="font-medium">{l.name}</h2>
                {l.description && <p className="text-xs text-muted-foreground mt-0.5">{l.description}</p>}
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="tabular-nums font-medium">{l.contactCount.toLocaleString()}</span>
                <span className="text-muted-foreground">subscribers</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleDateString()}</span>
                <div className="flex gap-1">
                  <Link to="/dashboard/contacts" search={{ list: l.id }}>
                    <Button variant="outline" size="sm">Manage</Button>
                  </Link>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => remove(l)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
