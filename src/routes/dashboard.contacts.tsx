import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Trash2, Search, Upload, FileText, Loader2, X, Download, ChevronRight, Pencil, Save, Clock, Mail, MousePointer, Eye, AlertCircle, List, LogOut, Activity } from "lucide-react";

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
  customFields?: Record<string, unknown>;
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
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [editingFields, setEditingFields] = useState(false);
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>({});
  const [savingFields, setSavingFields] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldVal, setNewFieldVal] = useState("");
  const [timeline, setTimeline] = useState<{ type: string; timestamp: string; data: Record<string, unknown> }[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [engagement, setEngagement] = useState<{ score: number; tier: string } | null>(null);
  const [engagementLoading, setEngagementLoading] = useState(false);
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
      .get<{ data: { id: string; status: string; subscribedAt: string; contact: { email: string; firstName: string | null; lastName: string | null; customFields?: Record<string, unknown> } }[] }>(`/v1/lists/${selectedList}/contacts?page=1&limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`, primaryKey.keyRaw)
      .then((r) => setContacts((r.data ?? []).map((m) => ({
        id: m.id,
        email: m.contact?.email ?? "",
        firstName: m.contact?.firstName ?? null,
        lastName: m.contact?.lastName ?? null,
        status: m.status,
        subscribedAt: m.subscribedAt,
        customFields: m.contact?.customFields ?? {},
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

  const saveCustomFields = async () => {
    if (!primaryKey?.keyRaw || !detailContact) return;
    setSavingFields(true);
    try {
      const fields: Record<string, string> = { ...fieldDraft };
      if (newFieldKey.trim()) fields[newFieldKey.trim()] = newFieldVal;
      await api.withKey.patch(`/v1/contacts/${encodeURIComponent(detailContact.email)}`, {
        custom_fields: fields,
      }, primaryKey.keyRaw);
      toast.success("Custom fields saved");
      setDetailContact((d) => d ? { ...d, customFields: fields } : d);
      setContacts((cs) => cs.map((c) => c.email === detailContact.email ? { ...c, customFields: fields } : c));
      setEditingFields(false);
      setNewFieldKey("");
      setNewFieldVal("");
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSavingFields(false); }
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
    try {
      // Use the fast bulk import endpoint — handles up to 50k contacts in one request
      const contacts = importPreview.map((row) => ({
        email: (row.email ?? "").trim().toLowerCase(),
        first_name: row.first_name || row.firstname || row["first name"] || undefined,
        last_name: row.last_name || row.lastname || row["last name"] || undefined,
      })).filter((c) => c.email.includes("@"));

      const res = await fetch("https://api.continuumapi.com/v1/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ list_id: selectedList, contacts }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? `Import failed (${res.status})`);
      }

      const data = await res.json() as { imported?: number; skipped?: number; suppressedSkipped?: number };
      const imported = data.imported ?? contacts.length;
      const skipped = (data.skipped ?? 0) + (data.suppressedSkipped ?? 0);
      toast.success(`${imported.toLocaleString()} contacts imported${skipped > 0 ? `, ${skipped} skipped` : ""}`);
      setImportPreview(null);
      setImportFile("");
      loadContacts();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const loadTimeline = (email: string) => {
    if (!primaryKey?.keyRaw) return;
    setTimelineLoading(true);
    setTimeline([]);
    api.withKey
      .get<{ events: { type: string; timestamp: string; data: Record<string, unknown> }[] }>(`/v1/contacts/${encodeURIComponent(email)}/timeline`, primaryKey.keyRaw)
      .then((r) => setTimeline(r.events ?? []))
      .catch(() => {})
      .finally(() => setTimelineLoading(false));
  };

  const loadEngagement = (email: string) => {
    if (!primaryKey?.keyRaw) return;
    setEngagementLoading(true);
    setEngagement(null);
    api.withKey
      .get<{ engagement_score: number; tier: string }>(`/v1/contacts/${encodeURIComponent(email)}/engagement`, primaryKey.keyRaw)
      .then((r) => setEngagement({ score: r.engagement_score ?? 0, tier: r.tier ?? "unknown" }))
      .catch(() => {})
      .finally(() => setEngagementLoading(false));
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
      {/* Contact detail drawer */}
      {detailContact && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { setDetailContact(null); setEditingFields(false); setTimeline([]); setEngagement(null); }}>
          <div className="bg-black/40 absolute inset-0" />
          <div className="relative bg-card border-l border-border w-full max-w-sm h-full overflow-y-auto shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
              <div>
                <p className="font-medium text-sm">{[detailContact.firstName, detailContact.lastName].filter(Boolean).join(" ") || "—"}</p>
                <p className="text-xs text-muted-foreground font-mono">{detailContact.email}</p>
              </div>
              <button onClick={() => { setDetailContact(null); setEditingFields(false); setTimeline([]); setEngagement(null); }} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-5 flex-1">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</p>
                <StatusBadge status={detailContact.status ?? "subscribed"} />
              </div>
              {/* Engagement score */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Engagement</p>
                </div>
                {engagementLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : engagement ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl font-semibold tabular-nums">{engagement.score}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${
                        ["champion", "loyal", "potential_loyalist"].includes(engagement.tier)
                          ? "bg-[oklch(0.95_0.05_145)] text-[oklch(0.35_0.12_145)] border-[oklch(0.85_0.08_145)]"
                          : ["at_risk", "hibernating"].includes(engagement.tier)
                          ? "bg-[oklch(0.97_0.06_75)] text-[oklch(0.42_0.13_60)] border-[oklch(0.88_0.1_75)]"
                          : "bg-muted text-muted-foreground border-border"
                      }`}>
                        {engagement.tier.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${engagement.score}%`,
                          background: engagement.score >= 60
                            ? "oklch(0.55 0.16 145)"
                            : engagement.score >= 30
                            ? "oklch(0.65 0.14 75)"
                            : "oklch(0.7 0.1 0)",
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">Score out of 100, based on opens, clicks, and recency.</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">No engagement data yet.</p>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Subscribed</p>
                <p className="text-sm">{detailContact.subscribedAt ? new Date(detailContact.subscribedAt).toLocaleDateString() : "—"}</p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Custom Fields</p>
                  {!editingFields && (
                    <button onClick={() => { setEditingFields(true); setFieldDraft(Object.fromEntries(Object.entries(detailContact.customFields ?? {}).map(([k, v]) => [k, String(v)]))); }} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                  )}
                </div>
                {editingFields ? (
                  <div className="space-y-2">
                    {Object.entries(fieldDraft).map(([k, v]) => (
                      <div key={k} className="flex gap-2 items-center">
                        <span className="text-xs font-mono text-muted-foreground w-24 shrink-0 truncate">{k}</span>
                        <Input
                          value={v}
                          onChange={(e) => setFieldDraft((d) => ({ ...d, [k]: e.target.value }))}
                          className="h-7 text-xs"
                        />
                        <button onClick={() => setFieldDraft((d) => { const n = { ...d }; delete n[k]; return n; })} className="text-muted-foreground hover:text-destructive shrink-0"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ))}
                    <div className="flex gap-2 items-center pt-1 border-t border-border">
                      <Input placeholder="key" value={newFieldKey} onChange={(e) => setNewFieldKey(e.target.value)} className="h-7 text-xs w-24 shrink-0" />
                      <Input placeholder="value" value={newFieldVal} onChange={(e) => setNewFieldVal(e.target.value)} className="h-7 text-xs" />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="h-7 text-xs gap-1" onClick={saveCustomFields} disabled={savingFields}>
                        <Save className="h-3 w-3" />{savingFields ? "Saving…" : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEditingFields(false); setNewFieldKey(""); setNewFieldVal(""); }}>Cancel</Button>
                    </div>
                  </div>
                ) : Object.keys(detailContact.customFields ?? {}).length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No custom fields yet. Click Edit to add one.</p>
                ) : (
                  <div className="space-y-1.5">
                    {Object.entries(detailContact.customFields ?? {}).map(([k, v]) => (
                      <div key={k} className="flex justify-between text-sm">
                        <span className="text-muted-foreground font-mono text-xs">{k}</span>
                        <span className="font-medium text-xs max-w-[140px] truncate text-right">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Timeline */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Activity Timeline</p>
                </div>
                {timelineLoading ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : timeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No activity recorded yet.</p>
                ) : (
                  <div className="space-y-0 border-l border-border ml-1.5">
                    {timeline.map((ev, i) => {
                      const IconMap: Record<string, React.ElementType> = {
                        email_sent: Mail, email_opened: Eye, email_clicked: MousePointer,
                        email_bounced: AlertCircle, email_complained: AlertCircle,
                        list_subscribed: List, list_unsubscribed: LogOut,
                        unsubscribed: LogOut, suppressed: AlertCircle,
                      };
                      const colorMap: Record<string, string> = {
                        email_sent: "text-muted-foreground", email_opened: "text-green-600 dark:text-green-400",
                        email_clicked: "text-blue-600 dark:text-blue-400",
                        email_bounced: "text-red-600 dark:text-red-400", email_complained: "text-red-600 dark:text-red-400",
                        list_subscribed: "text-muted-foreground", list_unsubscribed: "text-orange-600 dark:text-orange-400",
                        unsubscribed: "text-orange-600 dark:text-orange-400", suppressed: "text-red-600 dark:text-red-400",
                      };
                      const labelMap: Record<string, string> = {
                        email_sent: "Email sent", email_opened: "Email opened", email_clicked: "Link clicked",
                        email_bounced: "Bounced", email_complained: "Spam complaint",
                        list_subscribed: "Subscribed to list", list_unsubscribed: "Unsubscribed from list",
                        unsubscribed: "Unsubscribed", suppressed: "Suppressed",
                      };
                      const Icon = IconMap[ev.type] ?? Mail;
                      return (
                        <div key={i} className="relative pl-5 pb-3 last:pb-0">
                          <span className={`absolute -left-[7px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background border border-border ${colorMap[ev.type] ?? "text-muted-foreground"}`}>
                            <Icon className="h-2 w-2" />
                          </span>
                          <p className={`text-xs font-medium ${colorMap[ev.type] ?? "text-foreground"}`}>{labelMap[ev.type] ?? ev.type}</p>
                          {(() => { const d = ev.data.subject ?? ev.data.list_name ?? ev.data.url ?? ev.data.reason; return d ? <p className="text-xs text-muted-foreground truncate">{String(d)}</p> : null; })()}
                          <p className="text-[10px] text-muted-foreground">{new Date(ev.timestamp).toLocaleString()}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
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
                <th className="px-5 py-3 font-medium w-20"></th>
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
                    <div className="flex gap-1 items-center">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => { setDetailContact(c); setEditingFields(false); loadTimeline(c.email); loadEngagement(c.email); }}>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => unsubscribe(c.email)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
