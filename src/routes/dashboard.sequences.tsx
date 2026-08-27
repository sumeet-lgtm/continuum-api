import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, GitBranch, Play, Pause, Users } from "lucide-react";

export const Route = createFileRoute("/dashboard/sequences")({
  head: () => ({ meta: [{ title: "Sequences — Continuum API" }] }),
  component: SequencesPage,
});

interface Sequence {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  status: string;
  trackOpens: boolean;
  stopOnReply: boolean;
  createdAt: string;
  _count?: { steps: number; enrollments: number };
}

function SequencesPage() {
  const { primaryKey } = useAuth();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "" });
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ sequences: Sequence[] }>("/v1/sequences", primaryKey.keyRaw)
      .then((r) => setSequences(r.data ?? r.sequences ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/sequences", {
        name: form.name,
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        stopOnReply: true,
        trackOpens: true,
        trackClicks: true,
      }, primaryKey.keyRaw);
      toast.success("Sequence created");
      setCreating(false);
      setForm({ name: "", fromName: "", fromEmail: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (seq: Sequence) => {
    if (!primaryKey?.keyRaw) return;
    const newStatus = seq.status === "active" ? "paused" : "active";
    try {
      await fetch(`https://api.continuumapi.com/v1/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ status: newStatus }),
      });
      setSequences((s) => s.map((x) => x.id === seq.id ? { ...x, status: newStatus } : x));
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">Multi-step cold outreach with conditions, delays, and reply detection.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Sequence
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">New Sequence</h2>
          <div className="space-y-1.5">
            <Label>Sequence name</Label>
            <Input placeholder="Cold Outreach Q4" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From name</Label>
              <Input placeholder="Sumeet" value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>From email</Label>
              <Input placeholder="sumeet@yourapp.com" value={form.fromEmail} onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Sequence"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : sequences.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No sequences yet. Create a multi-step cold outreach campaign with conditions and reply detection.</p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Sequence</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq) => (
            <div key={seq.id} className="rounded-lg border border-border bg-card p-5 flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium truncate">{seq.name}</h2>
                  <StatusBadge status={seq.status} />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{seq.fromName} &lt;{seq.fromEmail}&gt;</p>
              </div>
              <div className="flex items-center gap-4 text-sm shrink-0">
                <div className="text-center">
                  <div className="font-semibold tabular-nums">{seq._count?.steps ?? 0}</div>
                  <div className="text-xs text-muted-foreground">steps</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold tabular-nums">{seq._count?.enrollments ?? 0}</div>
                  <div className="text-xs text-muted-foreground">enrolled</div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" className="gap-1" onClick={() => toggleStatus(seq)}>
                  {seq.status === "active" ? <><Pause className="h-3 w-3" /> Pause</> : <><Play className="h-3 w-3" /> Resume</>}
                </Button>
                <Button variant="outline" size="sm" className="gap-1">
                  <Users className="h-3 w-3" /> Enroll
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
