import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Building2, Globe, Users, Edit2, Check, X,
  ExternalLink, Mail, Briefcase, MapPin,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/accounts/$id")({
  head: () => ({ meta: [{ title: "Account — Continuum" }] }),
  component: AccountDetailPage,
});

interface AccountLead {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  status: string;
  tags: string[];
  createdAt: string;
}

interface Account {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  revenue: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  country: string | null;
  notes: string | null;
  createdAt: string;
  _count: { leads: number };
  leads: AccountLead[];
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-muted text-muted-foreground",
  interested: "bg-muted text-[oklch(0.55_0.16_145)]",
  replied: "bg-muted text-[oklch(0.55_0.16_145)]",
  not_interested: "bg-muted text-[oklch(0.58_0.22_27)]",
  bounced: "bg-muted text-[oklch(0.58_0.22_27)]",
  unsubscribed: "bg-muted text-muted-foreground",
};

function AccountDetailPage() {
  const { id } = Route.useParams();
  const { primaryKey } = useAuth();
  const navigate = useNavigate();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Account>>({});
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    api.withKey
      .get<Account>(`/v1/accounts/${id}`, primaryKey.keyRaw)
      .then((r) => { setAccount(r); setEditForm(r); })
      .catch(() => toast.error("Failed to load account."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey, id]);

  const handleSave = async () => {
    if (!primaryKey?.keyRaw || !account) return;
    setSaving(true);
    try {
      const updated = await api.withKey.patch<Account>(`/v1/accounts/${id}`, editForm, primaryKey.keyRaw);
      toast.success("Account updated.");
      setEditing(false);
      setAccount(updated);
      setEditForm(updated);
      load();
    } catch { toast.error("Save failed."); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!account) return <div className="p-8 text-sm text-muted-foreground">Account not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate({ to: "/dashboard/accounts" })}>
          <ArrowLeft className="h-4 w-4" /> Accounts
        </Button>
      </div>

      {/* Hero */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <Building2 className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                className="text-xl font-semibold bg-transparent border-b border-input focus:outline-none w-full mb-1"
                value={editForm.name ?? ""}
                onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
              />
            ) : (
              <h1 className="text-xl font-semibold">{account.name}</h1>
            )}
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
              {account.industry && <span className="flex items-center gap-1"><Briefcase className="h-3.5 w-3.5" />{account.industry}</span>}
              {account.domain && <span className="flex items-center gap-1"><Globe className="h-3.5 w-3.5" />{account.domain}</span>}
              {(account.city || account.country) && (
                <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[account.city, account.country].filter(Boolean).join(", ")}</span>
              )}
              {account.employees && <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{account.employees.toLocaleString()} employees</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {account.website && (
              <a href={account.website} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="gap-1"><ExternalLink className="h-3.5 w-3.5" />Website</Button>
              </a>
            )}
            {editing ? (
              <>
                <Button variant="outline" size="sm" onClick={() => { setEditing(false); setEditForm(account); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="h-3.5 w-3.5 mr-1" />{saving ? "Saving…" : "Save"}
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Edit2 className="h-3.5 w-3.5 mr-1" />Edit
              </Button>
            )}
          </div>
        </div>

        {editing && (
          <div className="mt-4 grid grid-cols-2 gap-3 pt-4 border-t border-border">
            {(["domain","industry","employees","revenue","website","linkedin","city","country"] as const).map((field) => (
              <div key={field}>
                <label className="text-xs text-muted-foreground mb-1 block capitalize">{field}</label>
                <input
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  value={(editForm as Record<string, string | number | null | undefined>)[field]?.toString() ?? ""}
                  onChange={(e) => setEditForm(f => ({ ...f, [field]: e.target.value || undefined }))}
                />
              </div>
            ))}
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <textarea
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                rows={3}
                value={editForm.notes ?? ""}
                onChange={(e) => setEditForm(f => ({ ...f, notes: e.target.value || undefined }))}
              />
            </div>
          </div>
        )}

        {!editing && account.notes && (
          <p className="mt-4 text-sm text-muted-foreground border-t border-border pt-4">{account.notes}</p>
        )}
      </div>

      {/* Leads */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium">Leads <span className="text-muted-foreground font-normal">({account._count.leads})</span></h2>
        </div>
        {account.leads.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No leads linked to this account yet. Use Auto-match or assign leads from their profile.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Email</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Title</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {account.leads.map((lead) => (
                  <tr
                    key={lead.id}
                    className="hover:bg-muted/20 transition-colors cursor-pointer"
                    onClick={() => navigate({ to: "/dashboard/leads/$id", params: { id: lead.id } })}
                  >
                    <td className="px-4 py-3 font-medium">
                      {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Mail className="h-3 w-3" />
                        {lead.email}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{lead.title ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLES[lead.status] ?? "bg-muted text-muted-foreground"}`}>
                        {lead.status.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
