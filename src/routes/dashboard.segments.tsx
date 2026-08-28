import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Filter, Trash2, X, ChevronDown, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/dashboard/segments")({
  head: () => ({ meta: [{ title: "Segments — Continuum API" }] }),
  component: SegmentsPage,
});

interface FilterRule {
  field: string;
  operator: string;
  value: string;
}

interface Segment {
  id: string;
  name: string;
  listId: string | null;
  filterRules: FilterRule[];
  createdAt: string;
}

interface MailingList { id: string; name: string; }

const FIELDS = [
  { value: "email", label: "Email" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "status", label: "Status" },
  { value: "subscribed_after", label: "Subscribed after" },
  { value: "subscribed_before", label: "Subscribed before" },
];

const OPERATORS: Record<string, { value: string; label: string }[]> = {
  email: [
    { value: "equals", label: "equals" },
    { value: "not_equals", label: "does not equal" },
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
  ],
  first_name: [
    { value: "equals", label: "equals" },
    { value: "not_equals", label: "does not equal" },
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
  ],
  last_name: [
    { value: "equals", label: "equals" },
    { value: "not_equals", label: "does not equal" },
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
  ],
  status: [
    { value: "equals", label: "equals" },
    { value: "not_equals", label: "does not equal" },
  ],
  subscribed_after: [{ value: "after", label: "after" }],
  subscribed_before: [{ value: "before", label: "before" }],
};

function getOperators(field: string) {
  return OPERATORS[field] ?? OPERATORS["email"]!;
}

function emptyRule(): FilterRule {
  return { field: "email", operator: "contains", value: "" };
}

function SegmentsPage() {
  const { primaryKey } = useAuth();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", listId: "", rules: [emptyRule()] });

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    const headers = { "X-API-Key": primaryKey.keyRaw! };
    fetch("https://api.continuumapi.com/v1/segments", { headers })
      .then((r) => r.json())
      .then((r) => setSegments((r as { data: Segment[] }).data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
    fetch("https://api.continuumapi.com/v1/lists", { headers })
      .then((r) => r.json())
      .then((r) => setLists((r as { data: MailingList[] }).data ?? []))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [primaryKey]);

  const setRule = (i: number, patch: Partial<FilterRule>) => {
    setForm((f) => {
      const rules = f.rules.map((r, idx) => idx === i ? { ...r, ...patch } : r);
      if (patch.field) {
        const ops = getOperators(patch.field);
        if (!ops.find((o) => o.value === rules[i]!.operator)) {
          rules[i]!.operator = ops[0]!.value;
        }
      }
      return { ...f, rules };
    });
  };

  const addRule = () => setForm((f) => ({ ...f, rules: [...f.rules, emptyRule()] }));
  const removeRule = (i: number) => setForm((f) => ({ ...f, rules: f.rules.filter((_, idx) => idx !== i) }));

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (form.rules.some((r) => !r.value.trim())) { toast.error("All rule values are required"); return; }
    setSaving(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({
          name: form.name.trim(),
          list_id: form.listId || undefined,
          filter_rules: form.rules,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      toast.success("Segment created");
      setCreating(false);
      setForm({ name: "", listId: "", rules: [emptyRule()] });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    if (!window.confirm("Delete this segment?")) return;
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/segments/${id}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setSegments((s) => s.filter((x) => x.id !== id));
      toast.success("Segment deleted");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Segments</h1>
          <p className="text-sm text-muted-foreground">Filter-based contact segments for targeted campaigns.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Segment
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-5 max-w-2xl">
          <h2 className="text-sm font-semibold">New Segment</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Segment name *</Label>
              <Input
                placeholder="Active US subscribers"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            {lists.length > 0 && (
              <div className="space-y-1.5">
                <Label>Mailing list (optional)</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={form.listId}
                  onChange={(e) => setForm((f) => ({ ...f, listId: e.target.value }))}
                >
                  <option value="">— all contacts —</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Filter rules</Label>
              <p className="text-xs text-muted-foreground">All rules must match (AND logic)</p>
            </div>

            {form.rules.map((rule, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={rule.field}
                  onChange={(e) => setRule(i, { field: e.target.value })}
                >
                  {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={rule.operator}
                  onChange={(e) => setRule(i, { operator: e.target.value })}
                >
                  {getOperators(rule.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <Input
                  className="flex-1 h-8 text-sm"
                  placeholder={rule.field.includes("after") || rule.field.includes("before") ? "2024-01-01" : "value…"}
                  value={rule.value}
                  onChange={(e) => setRule(i, { value: e.target.value })}
                />
                {form.rules.length > 1 && (
                  <button onClick={() => removeRule(i)} className="text-muted-foreground hover:text-destructive shrink-0">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}

            <Button variant="outline" size="sm" className="gap-1.5" onClick={addRule}>
              <Plus className="h-3.5 w-3.5" /> Add Rule
            </Button>
          </div>

          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Segment"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : segments.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Filter className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No segments yet. Create filter-based groups to send targeted campaigns.</p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Segment</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {segments.map((seg) => (
            <div key={seg.id} className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="px-5 py-4 flex items-center justify-between gap-4">
                <button
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  onClick={() => setExpandedId(expandedId === seg.id ? null : seg.id)}
                >
                  {expandedId === seg.id
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{seg.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {seg.filterRules.length} rule{seg.filterRules.length !== 1 ? "s" : ""}
                      {seg.listId && lists.find((l) => l.id === seg.listId) && ` · ${lists.find((l) => l.id === seg.listId)!.name}`}
                      {" · "}Created {new Date(seg.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive shrink-0" onClick={() => del(seg.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {expandedId === seg.id && (
                <div className="border-t border-border bg-muted/20 px-5 py-4 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Filter Rules (all must match)</p>
                  {seg.filterRules.map((rule, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs font-mono">{rule.field}</span>
                      <span className="text-muted-foreground">{rule.operator}</span>
                      <span className="font-medium">"{rule.value}"</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
