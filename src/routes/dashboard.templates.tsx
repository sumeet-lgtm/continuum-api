import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Edit2, FileText, Eye, X } from "lucide-react";

export const Route = createFileRoute("/dashboard/templates")({
  head: () => ({ meta: [{ title: "Templates — Continuum API" }] }),
  component: TemplatesPage,
});

interface Template { id: string; name: string; subject: string; htmlBody?: string; createdAt: string; }

function TemplatesPage() {
  const { primaryKey } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", subject: "", html: "" });
  const [saving, setSaving] = useState(false);
  const [editTarget, setEditTarget] = useState<Template | null>(null);
  const [editForm, setEditForm] = useState({ name: "", subject: "", html: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ templates: Template[] }>("/v1/templates", primaryKey.keyRaw)
      .then((r) => setTemplates(r.templates ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/templates", { name: form.name, subject: form.subject, html_body: form.html }, primaryKey.keyRaw);
      toast.success("Template created");
      setCreating(false);
      setForm({ name: "", subject: "", html: "" });
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (t: Template) => {
    setEditTarget(t);
    setEditForm({ name: t.name, subject: t.subject, html: t.htmlBody ?? "" });
  };

  const saveEdit = async () => {
    if (!primaryKey?.keyRaw || !editTarget) return;
    setEditSaving(true);
    try {
      await fetch(`https://api.continuumapi.com/v1/templates/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ name: editForm.name, subject: editForm.subject, html_body: editForm.html }),
      });
      setTemplates((ts) => ts.map((t) => t.id === editTarget.id ? { ...t, name: editForm.name, subject: editForm.subject } : t));
      toast.success("Template updated");
      setEditTarget(null);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setEditSaving(false); }
  };

  const del = async (id: string) => {
    if (!primaryKey?.keyRaw || !confirm("Delete this template?")) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/templates/${id}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      setTemplates((t) => t.filter((x) => x.id !== id));
      toast.success("Template deleted");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Email Templates</h1>
          <p className="text-sm text-muted-foreground">Reusable templates with variable substitution.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Template
        </Button>
      </div>

      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-2xl space-y-4 shadow-xl">
            <h2 className="text-sm font-semibold">Edit Template</h2>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Subject</Label>
              <Input value={editForm.subject} onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>HTML Body</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={editForm.html}
                onChange={(e) => setEditForm((f) => ({ ...f, html: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={saveEdit} disabled={editSaving}>{editSaving ? "Saving…" : "Save Changes"}</Button>
              <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
          <h2 className="text-sm font-semibold">New Template</h2>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="Welcome Email" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input placeholder="Welcome, {{first_name}}!" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>HTML Body</Label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[120px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="<p>Hi {{first_name}},</p>"
              value={form.html}
              onChange={(e) => setForm((f) => ({ ...f, html: e.target.value }))}
            />
          </div>
          <p className="text-xs text-muted-foreground">Use {"{{variable_name}}"} syntax in subject and body. Pass values in the <code>variables</code> field when sending.</p>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Saving…" : "Create Template"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-40 bg-muted rounded animate-pulse" />
              <div className="h-3 w-28 bg-muted rounded animate-pulse" />
              <div className="h-3 w-16 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center space-y-3">
          <FileText className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">No templates yet. Create your first one to reuse across sends.</p>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Create template
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Subject</th>
                <th className="px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3 font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-medium">{t.name}</td>
                  <td className="px-5 py-3 text-muted-foreground max-w-xs truncate">{t.subject}</td>
                  <td className="px-5 py-3 text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPreviewTemplate(t)} title="Preview"><Eye className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(t)}><Edit2 className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => del(t.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-card">
            <div>
              <p className="text-sm font-medium">{previewTemplate.name}</p>
              <p className="text-xs text-muted-foreground">{previewTemplate.subject}</p>
            </div>
            <button onClick={() => setPreviewTemplate(null)} className="rounded p-1.5 hover:bg-muted transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <iframe
              srcDoc={previewTemplate.htmlBody ?? "<p style='font-family:sans-serif;color:#888;padding:2rem'>No HTML body set for this template.</p>"}
              sandbox="allow-same-origin"
              className="w-full h-full border-0 bg-white"
              title={`Preview: ${previewTemplate.name}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
