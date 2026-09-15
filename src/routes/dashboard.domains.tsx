import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, RefreshCw, ServerCog, CheckCircle2, XCircle, Clock, ShieldCheck, X, Copy, Check, KeyRound, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/dashboard/domains")({
  head: () => ({ meta: [{ title: "Sending Domains — Continuum" }] }),
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

interface DnsRecord { name: string; type: string; value: string; priority?: number; }
interface DnsRecords {
  dkim: DnsRecord;
  spf: DnsRecord;
  return_path: DnsRecord;
  dmarc: DnsRecord;
  // Only present when a backup send provider accepted the domain at add
  // time — not shown as a distinct branded step, just redundancy records
  // alongside the primary ones.
  dkim_secondary?: DnsRecord;
  return_path_secondary?: DnsRecord;
}

const DNS_RECORD_LABELS: Partial<Record<keyof DnsRecords, string>> = {
  dkim: "DKIM",
  spf: "SPF",
  return_path: "Return Path",
  dmarc: "DMARC",
  dkim_secondary: "DKIM (backup)",
  return_path_secondary: "Return Path (backup)",
};

interface HealthData {
  spf: { valid: boolean; record: string | null };
  dkim: { valid: boolean };
  dmarc: { valid: boolean; record: string | null };
  blacklisted: boolean;
  blacklistHits: string[];
  score: number;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "verified") return <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)]" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)]" />;
  return <Clock className="h-4 w-4 text-[oklch(0.65_0.16_75)]" />;
}

function DomainsPage() {
  const { primaryKey } = useAuth();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [domainName, setDomainName] = useState("");
  const [saving, setSaving] = useState(false);
  const [healthDomain, setHealthDomain] = useState<Domain | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [newDnsRecords, setNewDnsRecords] = useState<DnsRecords | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateDnsRecord, setRotateDnsRecord] = useState<{ type: string; host: string; value: string } | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    // GET /v1/domains returns { data: Domain[] } — this read r.domains,
    // which the API has never sent, so the list silently fell back to []
    // on every load after the initial add. A customer would see their
    // just-added domain once (from the POST response), then it would
    // vanish on the next page visit with no error, no indication anything
    // was wrong — just an empty list where their domain used to be.
    api.withKey
      .get<{ data: Domain[] }>("/v1/domains", primaryKey.keyRaw)
      .then((r) => setDomains(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  // Light polling while any domain is still pending — DKIM verification is
  // Amazon SES polling on its own schedule (minutes to hours after the DNS
  // record is already live), and the backend now rechecks every 15 minutes
  // on its own (domainVerifyWorker.ts) — but a customer watching this page
  // shouldn't have to keep clicking Re-verify themselves to see the result
  // land. Only polls while it matters, and stops as soon as nothing is
  // pending anymore.
  useEffect(() => {
    if (!domains.some((d) => d.status === "pending")) return;
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains.map((d) => d.status).join(",")]);

  const copyDns = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const add = async () => {
    if (!primaryKey?.keyRaw || !domainName.trim()) return;
    setSaving(true);
    try {
      const res = await api.withKey.post<Domain & { dns_records: DnsRecords }>(
        "/v1/domains",
        { name: domainName.trim() },
        primaryKey.keyRaw,
      );
      toast.success(`Domain ${res.name} added — add the DNS records below to your registrar.`);
      setNewDnsRecords(res.dns_records);
      setAdding(false);
      setDomainName("");
      setDomains((prev) => [res, ...prev]);
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

  const rotateDkim = async (domain: Domain) => {
    if (!primaryKey?.keyRaw) return;
    if (!confirm(`Rotate DKIM keys for ${domain.name}?\n\nA new key pair will be generated. You'll need to update the DNS TXT record and re-verify the domain. Email sending continues with the old key until re-verified.`)) return;
    setRotatingId(domain.id);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/domains/${domain.id}/rotate-dkim`, {
        method: "POST",
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      const data = await res.json() as { dnsRecord: { type: string; host: string; value: string }; message: string };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed");
      setRotateDnsRecord(data.dnsRecord);
      toast.success("DKIM keys rotated — update DNS to complete");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setRotatingId(null);
    }
  };

  const checkHealth = async (domain: Domain) => {
    if (!primaryKey?.keyRaw) return;
    setHealthDomain(domain);
    setHealthData(null);
    setHealthLoading(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/domains/${domain.id}/health`, {
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      setHealthData(data as HealthData);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setHealthLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Sending Domains</h1>
          <p className="text-sm text-muted-foreground">Add custom domains with DKIM/SPF authentication.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add Domain
        </Button>
      </div>

      {/* Health modal */}
      {healthDomain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Domain Health</h2>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{healthDomain.name}</p>
              </div>
              <button onClick={() => { setHealthDomain(null); setHealthData(null); }} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {healthLoading ? (
              <p className="text-sm text-muted-foreground">Checking DNS and blacklists…</p>
            ) : healthData ? (
              <>
                {/* Score */}
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 rounded-full flex items-center justify-center text-xl font-bold border-4" style={{
                    borderColor: healthData.score >= 80 ? "oklch(0.55 0.16 145)" : healthData.score >= 50 ? "oklch(0.78 0.16 75)" : "oklch(0.58 0.22 27)",
                    color: healthData.score >= 80 ? "oklch(0.55 0.16 145)" : healthData.score >= 50 ? "oklch(0.78 0.16 75)" : "oklch(0.58 0.22 27)",
                  }}>
                    {healthData.score}
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {healthData.score >= 80 ? "Excellent" : healthData.score >= 50 ? "Needs Work" : "Poor"}
                    </p>
                    <p className="text-xs text-muted-foreground">Deliverability score out of 100</p>
                  </div>
                </div>

                {/* Checks */}
                <div className="space-y-2">
                  {[
                    { label: "SPF", valid: healthData.spf.valid, detail: healthData.spf.record ?? "No record found" },
                    { label: "DKIM", valid: healthData.dkim.valid, detail: healthData.dkim.valid ? "Signature verified" : "Not configured" },
                    { label: "DMARC", valid: healthData.dmarc.valid, detail: healthData.dmarc.record ?? "No _dmarc TXT record" },
                    { label: "Blacklists", valid: !healthData.blacklisted, detail: healthData.blacklisted ? `Listed on: ${healthData.blacklistHits.join(", ")}` : "Clean on all checked lists" },
                  ].map(({ label, valid, detail }) => (
                    <div key={label} className="flex items-start gap-3">
                      {valid
                        ? <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)] shrink-0 mt-0.5" />
                        : <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)] shrink-0 mt-0.5" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground truncate">{detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <Button variant="outline" size="sm" className="w-full" onClick={() => { setHealthDomain(null); setHealthData(null); }}>Close</Button>
          </div>
        </div>
      )}

      {/* DNS records panel shown after successful domain add */}
      {newDnsRecords && (
        <div className="rounded-lg border border-border bg-muted/60 p-6 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[oklch(0.55_0.16_145)]">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <p className="text-sm font-medium">Domain added — add these DNS records to your registrar to verify</p>
            </div>
            <button onClick={() => setNewDnsRecords(null)} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3">
            {(Object.entries(newDnsRecords) as [keyof DnsRecords, DnsRecord][]).map(([key, rec]) => (
              <div key={key} className="rounded-md border border-border bg-card p-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{DNS_RECORD_LABELS[key] ?? key.replace(/_/g, " ")}</span>
                  <span className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono">{rec.type}</span>
                </div>
                <div className="grid grid-cols-[auto,1fr,auto] gap-2 items-center">
                  <span className="text-xs text-muted-foreground">Name</span>
                  <code className="text-xs font-mono truncate">{rec.name}</code>
                  <button onClick={() => copyDns(`${key}-name`, rec.name)} className="text-muted-foreground hover:text-foreground shrink-0">
                    {copiedKey === `${key}-name` ? <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div className="grid grid-cols-[auto,1fr,auto] gap-2 items-start">
                  <span className="text-xs text-muted-foreground mt-0.5">Value</span>
                  <code className="text-xs font-mono break-all leading-relaxed">{rec.value}</code>
                  <button onClick={() => copyDns(`${key}-value`, rec.value)} className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5">
                    {copiedKey === `${key}-value` ? <Check className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">DNS changes can take up to 48 hours to propagate. Click Re-check on the domain row once records are added.</p>
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">Add Sending Domain</h2>
          <div className="space-y-1.5">
            <Label>Domain name</Label>
            <Input placeholder="mail.yourapp.com" value={domainName} onChange={(e) => setDomainName(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">We'll generate DKIM keys and return DNS records to add to your registrar. We recheck automatically every 15 minutes once you've added them — DKIM specifically can take a few minutes to a few hours to clear even after the DNS record is live, since that verification runs on our upstream provider's own schedule, not ours.</p>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Domain"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-48 bg-muted rounded animate-pulse" />
              <div className="h-5 w-16 bg-muted rounded-full animate-pulse" />
              <div className="h-3 w-24 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : domains.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center space-y-3">
          <ServerCog className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">No sending domains yet. Add a custom domain to improve deliverability with DKIM signing.</p>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Add domain
          </Button>
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
                <th className="px-5 py-3 font-medium w-32"></th>
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
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" title="Domain health check" onClick={() => checkHealth(d)}>
                        <ShieldCheck className="h-3 w-3" /> Health
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Re-verify DNS" onClick={() => recheck(d.id)}>
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        title="Rotate DKIM keys"
                        onClick={() => void rotateDkim(d)}
                        disabled={rotatingId === d.id}
                      >
                        <KeyRound className={`h-3.5 w-3.5 ${rotatingId === d.id ? "animate-spin opacity-50" : ""}`} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* DKIM rotation result */}
      {rotateDnsRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="rounded-lg border border-border bg-card w-full max-w-lg shadow-xl space-y-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <KeyRound className="h-4 w-4" /> DKIM Keys Rotated
              </h2>
              <button onClick={() => setRotateDnsRecord(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="rounded-md bg-[oklch(0.65_0.16_75)]/10 border border-[oklch(0.65_0.16_75)]/30 px-4 py-3 flex gap-3">
              <AlertTriangle className="h-4 w-4 text-[oklch(0.65_0.16_75)] shrink-0 mt-0.5" />
              <p className="text-sm text-[oklch(0.65_0.16_75)]">
                Update the DNS record below, then click Re-verify DNS to complete rotation. Email signing continues with the old key until then.
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">New DNS TXT Record</p>
              <div className="rounded-md border border-border overflow-hidden text-xs font-mono">
                <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
                  <span className="text-muted-foreground">Host</span>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(rotateDnsRecord.host); toast.success("Host copied"); }}
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="px-3 py-2 break-all">{rotateDnsRecord.host}</div>
                <div className="px-3 py-2 border-t border-border bg-muted/40 flex items-center justify-between">
                  <span className="text-muted-foreground">Value</span>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(rotateDnsRecord.value); toast.success("Value copied"); }}
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
                <div className="px-3 py-2 break-all">{rotateDnsRecord.value}</div>
              </div>
            </div>
            <Button size="sm" onClick={() => setRotateDnsRecord(null)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}
