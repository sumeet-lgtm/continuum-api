import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, RefreshCw, ServerCog, CheckCircle2, XCircle, Clock } from "lucide-react";

export const Route = createFileRoute("/dashboard/domains")({
  head: () => ({ meta: [{ title: "Sending Domains — Continuum API" }] }),
  component: DomainsPage,
});

interface Domain {
  id: string;
  name: string;
  status: string;
  spfStatus: string;
  dkimStatus: string;
  returnPathStatus: string;
  createdAt: string;
  verifiedAt: string | null;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "verified") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-yellow-500" />;
}

function DomainsPage() {
  const { primaryKey } = useAuth();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [domainName, setDomainName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ domains: Domain[] }>("/v1/domains", primaryKey.keyRaw)
      .then((r) => setDomains(r.data ?? r.domains ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const add = async () => {
    if (!primaryKey?.keyRaw || !domainName.trim()) return;
    setSaving(true);
    try {
      const res = await api.withKey.post<{ domain: Domain; dnsRecords: unknown[] }>(
        "/v1/domains",
        { name: domainName.trim() },
        primaryKey.keyRaw,
      );
      toast.success(`Domain ${res.domain.name} added — add the DNS records to verify.`);
      setAdding(false);
      setDomainName("");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const recheck = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.post(`/v1/domains/${id}/verify`, {}, primaryKey.keyRaw);
      toast.success("DNS status refreshed");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Sending Domains</h1>
          <p className="text-sm text-muted-foreground">Add custom domains with DKIM/SPF authentication.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add Domain
        </Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">Add Sending Domain</h2>
          <div className="space-y-1.5">
            <Label>Domain name</Label>
            <Input placeholder="mail.yourapp.com" value={domainName} onChange={(e) => setDomainName(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">We'll generate DKIM keys and return DNS records to add to your registrar. Verification happens automatically once DNS propagates.</p>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Domain"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : domains.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <ServerCog className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No sending domains yet. Add a custom domain to improve deliverability with DKIM signing.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Domain</th>
                <th className="px-5 py-3 font-medium">SPF</th>
                <th className="px-5 py-3 font-medium">DKIM</th>
                <th className="px-5 py-3 font-medium">Return Path</th>
                <th className="px-5 py-3 font-medium">Added</th>
                <th className="px-5 py-3 font-medium w-24"></th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-5 py-3 font-mono text-xs font-medium">{d.name}</td>
                  <td className="px-5 py-3"><StatusIcon status={d.spfStatus} /></td>
                  <td className="px-5 py-3"><StatusIcon status={d.dkimStatus} /></td>
                  <td className="px-5 py-3"><StatusIcon status={d.returnPathStatus} /></td>
                  <td className="px-5 py-3 text-muted-foreground">{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-3">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => recheck(d.id)}>
                      <RefreshCw className="h-3.5 w-3.5" />
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
