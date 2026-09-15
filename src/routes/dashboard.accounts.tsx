import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  Building2, Plus, Search, RefreshCw, ChevronRight,
  Globe, Users, ExternalLink, Trash2, X, Check, Link2,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/accounts")({
  head: () => ({ meta: [{ title: "Target Accounts — Continuum" }] }),
  component: AccountsPage,
});

interface Account {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  website: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
  _count?: { leads: number };
}

const INDUSTRIES = [
  "SaaS", "FinTech", "HealthTech", "E-commerce", "EdTech", "MarTech",
  "AgriTech", "Logistics", "Consulting", "Manufacturing", "Retail",
  "Media", "Legal", "Real Estate", "Recruiting", "Other",
];

function AccountsPage() {
  const { primaryKey } = useAuth();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [form, setForm] = useState({
    name: "", domain: "", industry: "", employees: "", website: "",
    city: "", country: "",
  });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (q?: string) => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    const qs = new URLSearchParams({ limit: "50" });
    if (q !== undefined ? q : search) qs.set("search", q ?? search);
    api.withKey
      .get<{ data: Account[]; total: number }>(`/v1/accounts?${qs}`, primaryKey.keyRaw)
      .then((r) => { setAccounts(r.data ?? []); setTotal(r.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const onSearch = (v: string) => {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(v), 400);
  };

  const handleCreate = async () => {
    if (!primaryKey?.keyRaw || !form.name.trim()) return;
    setSaving(true);
    try {
      const created = await api.withKey.post<Account>("/v1/accounts", {
        name: form.name.trim(),
        domain: form.domain.trim() || undefined,
        industry: form.industry || undefined,
        employees: form.employees ? parseInt(form.employees) : undefined,
        website: form.website.trim() || undefined,
        city: form.city.trim() || undefined,
        country: form.country.trim() || undefined,
      }, primaryKey.keyRaw);
      toast.success("Account created.");
      setShowNew(false);
      setForm({ name: "", domain: "", industry: "", employees: "", website: "", city: "", country: "" });
      setAccounts((prev) => [{ ...created, _count: { leads: 0 } }, ...prev]);
      setTotal((prev) => prev + 1);
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message ?? "Failed to create account.");
    } finally { setSaving(false); }
  };

  const handleAutoMatch = async () => {
    if (!primaryKey?.keyRaw) return;
    setAutoMatching(true);
    try {
      const res = await api.withKey.post<{ matched: number }>("/v1/accounts/auto-match", {}, primaryKey.keyRaw);
      toast.success(`Auto-matched ${res.matched} lead${res.matched !== 1 ? "s" : ""} to accounts.`);
      load();
    } catch { toast.error("Auto-match failed."); }
    finally { setAutoMatching(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!primaryKey?.keyRaw) return;
    if (!confirm(`Delete account "${name}"? Leads will be unlinked.`)) return;
    try {
      await api.withKey.del(`/v1/accounts/${id}`, primaryKey.keyRaw);
      toast.success("Account deleted.");
      load();
    } catch { toast.error("Delete failed."); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Target Accounts</h1>
          <p className="text-sm text-muted-foreground">Companies and organizations your leads belong to.</p>
        </header>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleAutoMatch} disabled={autoMatching}>
            <Link2 className="h-3.5 w-3.5" />
            {autoMatching ? "Matching…" : "Auto-match Leads"}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Account
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search accounts…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* New account form */}
      {showNew && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">New Account</h3>
            <button onClick={() => setShowNew(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Company Name *</label>
              <input
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Acme Inc."
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Domain</label>
              <input
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="acme.com"
                value={form.domain}
                onChange={(e) => setForm(f => ({ ...f, domain: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Industry</label>
              <select
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                value={form.industry}
                onChange={(e) => setForm(f => ({ ...f, industry: e.target.value }))}
              >
                <option value="">— Select —</option>
                {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Employees</label>
              <input
                type="number"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="250"
                value={form.employees}
                onChange={(e) => setForm(f => ({ ...f, employees: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Website</label>
              <input
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="https://acme.com"
                value={form.website}
                onChange={(e) => setForm(f => ({ ...f, website: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">City</label>
              <input
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="San Francisco"
                value={form.city}
                onChange={(e) => setForm(f => ({ ...f, city: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Country</label>
              <input
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="United States"
                value={form.country}
                onChange={(e) => setForm(f => ({ ...f, country: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} disabled={saving || !form.name.trim()}>
              {saving ? "Creating…" : <><Check className="h-3.5 w-3.5 mr-1" />Create Account</>}
            </Button>
          </div>
        </div>
      )}

      {/* Accounts list */}
      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-36 bg-muted rounded animate-pulse" />
                <div className="h-3 w-24 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Building2 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No accounts yet.</p>
          <p className="text-xs text-muted-foreground">Create accounts to group leads by company, then track engagement at the account level.</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{total} account{total !== 1 ? "s" : ""}</p>
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Company</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Domain</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Industry</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Employees</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Leads</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Location</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accounts.map((a) => (
                  <tr
                    key={a.id}
                    className="hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => navigate({ to: "/dashboard/accounts/$id", params: { id: a.id } })}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <span className="font-medium truncate max-w-[180px]">{a.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {a.domain ? (
                        <div className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          <span>{a.domain}</span>
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{a.industry ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.employees?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Users className="h-3 w-3" />
                        <span>{a._count?.leads ?? 0}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {[a.city, a.country].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                        {a.website && (
                          <a href={a.website} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-muted text-muted-foreground">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <button
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(a.id, a.name)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
