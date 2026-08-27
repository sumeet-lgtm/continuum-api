import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Trash2, Search } from "lucide-react";

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

  useEffect(() => {
    if (!primaryKey?.keyRaw || !selectedList) return;
    setLoading(true);
    api.withKey
      .get<{ data: Contact[]; total: number }>(`/v1/lists/${selectedList}/contacts?page=1&limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`, primaryKey.keyRaw)
      .then((r) => setContacts(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [primaryKey, selectedList, search]);

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
      // Re-fetch
      const r = await api.withKey.get<{ data: Contact[] }>(`/v1/lists/${selectedList}/contacts?page=1&limit=100`, primaryKey.keyRaw);
      setContacts(r.data ?? []);
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

  const currentList = lists.find((l) => l.id === selectedList);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">Manage subscribers across your mailing lists.</p>
        </header>
        {selectedList && (
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add Contact
          </Button>
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
            <Input placeholder="subscriber@example.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
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
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No contacts in {currentList?.name} yet.</p>
          <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> Add First Contact</Button>
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => unsubscribe(c.email)}
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
