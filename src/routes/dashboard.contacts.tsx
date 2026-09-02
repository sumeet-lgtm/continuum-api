import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Trash2, Search, Upload, FileText, Loader2, X, Download } from "lucide-react";

export const Route = createFileRoute("/dashboard/contacts")({
  head: () => ({ meta: [{ title: "Contacts — Continuum API" }] }),
  component: ContactsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    list: typeof s["list"] === "string" ? s["list"] : undefined,
  }),
});

interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status?: string;
  subscribedAt?: string;
  createdAt?: string;
}

interface MailingList { id: string; name: string; }

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  }).filter((r) => r.email);
}

function ContactsPage() {
  const { primaryKey } = useAuth();
  const { list: listId } = useSearch({ from: "/dashboard/contacts" });

  const [lists, setLists] = useState<MailingList[]>([]);
  const [selectedList, setSelectedList] = useState<string>(listId ?? "");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "" });
  const [saving, setSaving] = useState(false);
  const [importPreview, setImportPreview] = useState<Record<string, string>[] | null>(null);
  const [importFile, setImportFile] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => {
        const l = r.data ?? [];
        setLists(l);
        if (!selectedList && l.length > 0) setSelectedList(l[0]!.id);
      })
      .catch(() => {});
  }, [primaryKey]);

  const loadContacts = () => {
    if (!primaryKey?.keyRaw || !selectedList) return;
    setLoading(true);
    api.withKey
      .get<{ data: { id: string; status: string; subscribedAt: string; contact: { email: string; firstName: string | null; lastName: string | null } }[] }>(`/v1/lists/${selectedList}/contacts?page=1&limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`, primaryKey.keyRaw)
      .then((r) => setContacts((r.data ?? []).map((m) => ({
        id: m.id,
        email: m.contact?.email ?? "",
        firstName: m.contact?.firstName ?? null,
        lastName: m.contact?.lastName ?? null,
        status: m.status,
        subscribedAt: m.subscribedAt,
      }))))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadContacts(); }, [primaryKey, selectedList, search]);

  const subscribe = async () => {
    if (!primaryKey?.keyRaw || !selectedList) return;
    if (!form.email) { toast.error("Email is required"); return; }
    setSaving(true);
    try {
      await api.withKey.post(`/v1/lists/${selectedList}/contacts`, {
        email: form.email,
        first_name: form.firstName || undefined,
        last_name: form.lastName || undefined,
        silent: true,
      }, primaryKey.keyRaw);
      toast.success("Contact subscribed");
      setAdding(false);
      setForm({ email: "", firstName: "", lastName: "" });
      loadContacts();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const unsubscribe = async (email: string) => {
    if (!primaryKey?.keyRaw || !selectedList) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/lists/${selectedList}/contacts/${encodeURIComponent(email)}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      setContacts((c) => c.filter((x) => x.email !== email));
      toast.success("Contact unsubscribed");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseCSV(ev.target?.result as string);
      setImportPreview(rows);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const runImport = async () => {
    if (!primaryKey?.keyRaw || !selectedList || !importPreview?.length) return;
    setImporting(true);
    let ok = 0;
    let failed = 0;
    // POST one at a time in batches of 50 (no bulk endpoint for contacts yet)
    const BATCH = 50;
    try {
      for (let i = 0; i < importPreview.length; i += BATCH) {
        const chunk = importPreview.slice(i, i + BATCH);
        await Promise.all(chunk.map(async (row) => {
          try {
            await fetch(`https://api.continuumapi.com/v1/lists/${selectedList}/contacts`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
              body: JSON.stringify({
                email: row.email,
                first_name: row.first_name || row.firstname || row["first name"] || undefined,
                last_name: row.last_name || row.lastname || row["last name"] || undefined,
                silent: true,
              }),
            });
            ok++;
          } catch { failed++; }
        }));
      }
      toast.success(`${ok} contacts imported${failed > 0 ? `, ${failed} skipped` : ""}`);
      setImportPreview(null);
      setImportFile("");
      loadContacts();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const exportContacts = async () => {
    if (!primaryKey?.keyRaw || !selectedList) return;
    setExporting(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/lists/${selectedList}/contacts/export`, {
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      const listName = lists.find((l) => l.id === selectedList)?.name ?? "contacts";
      a.href = url;
      a.download = `${listName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}-${date}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setExporting(false); }
  };

  const currentList = lists.find((l) => l.id === selectedList);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">Manage subscribers across your mailing lists.</p>
        </header>
        {selectedList && (
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileSelect} />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={exportContacts} disabled={exporting || contacts.length === 0}>
              <Download className="h-4 w-4" /> {exporting ? "Exporting…" : "Export CSV"}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Import CSV
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add Contact
            </Button>
          </div>
        )}
      </div>

      {/* List selector */}
      {lists.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelectedList(l.id)}
              className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                selectedList === l.id
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}

      {/* Add contact form */}
      {adding && selectedList && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">Add Contact to {currentList?.name}</h2>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input placeholder="subscriber@example.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First name</Label>
              <Input placeholder="Alice" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input placeholder="Smith" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={subscribe} disabled={saving}>{saving ? "Adding…" : "Subscribe"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* CSV import preview */}
      {importPreview && selectedList && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{importFile}</p>
                <p className="text-xs text-muted-foreground">
                  {importPreview.length.toLocaleString()} contacts → {currentList?.name}
                </p>
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
                  <th className="px-3 py-2 text-left font-medium">First name</th>
                  <th className="px-3 py-2 text-left font-medium">Last name</th>
                </tr>
              </thead>
              <tbody>
                {importPreview.slice(0, 5).map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 font-mono">{row.email}</td>
                    <td className="px-3 py-1.5">{row.first_name || row.firstname || row["first name"] || "—"}</td>
                    <td className="px-3 py-1.5">{row.last_name || row.lastname || row["last name"] || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {importPreview.length > 5 && (
              <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
                + {(importPreview.length - 5).toLocaleString()} more rows
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Expected columns: <code className="bg-muted rounded px-1">email</code>, <code className="bg-muted rounded px-1">first_name</code>, <code className="bg-muted rounded px-1">last_name</code>
          </p>
          <div className="flex gap-2">
            <Button onClick={runImport} disabled={importing} className="gap-1.5">
              {importing
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…</>
                : <><Upload className="h-3.5 w-3.5" /> Import {importPreview.length.toLocaleString()} Contacts</>}
            </Button>
            <Button variant="outline" onClick={() => { setImportPreview(null); setImportFile(""); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Search */}
      {contacts.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contacts…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {!selectedList ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Create a mailing list first, then manage subscribers here.</p>
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="px-5 py-3 flex items-center gap-4">
              <div className="h-3 w-40 bg-muted rounded animate-pulse" />
              <div className="h-3 w-28 bg-muted rounded animate-pulse" />
              <div className="h-3 w-20 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : contacts.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No contacts in {currentList?.name} yet.</p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Import CSV
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> Add First Contact</Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border text-xs text-muted-foreground bg-muted/40">
            {contacts.length.toLocaleString()} contact{contacts.length !== 1 ? "s" : ""} in {currentList?.name}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Subscribed</th>
                <th className="px-5 py-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-mono text-xs">{c.email}</td>
                  <td className="px-5 py-3">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td className="px-5 py-3"><StatusBadge status={c.status ?? "subscribed"} /></td>
                  <td className="px-5 py-3 text-muted-foreground text-xs">
                    {c.subscribedAt ? new Date(c.subscribedAt).toLocaleDateString() : c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => unsubscribe(c.email)}>
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
