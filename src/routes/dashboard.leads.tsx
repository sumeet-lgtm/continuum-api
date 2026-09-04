import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Users, Upload, X, FileText, Loader2, Search, Sparkles, GitBranch, CheckSquare, Square, Wand2, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/dashboard/leads")({
  head: () => ({ meta: [{ title: "Leads — Continuum API" }] }),
  component: LeadsPage,
});

interface Lead {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  status: string;
  tags: string[];
  createdAt: string;
}

// Parse a CSV string → array of row objects using first row as headers.
// Handles RFC-4180 quoted fields (commas + newlines inside quotes).
function parseCSV(text: string): Record<string, string>[] {
  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === "," && !inQuotes) {
        fields.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  }).filter((r) => r.email);
}

// Map CSV row to lead shape the API expects
function rowToLead(row: Record<string, string>) {
  return {
    email: row.email,
    first_name: row.first_name || row.firstname || row["first name"] || undefined,
    last_name: row.last_name || row.lastname || row["last name"] || undefined,
    company: row.company || row.organization || undefined,
    title: row.title || row.job_title || row["job title"] || undefined,
  };
}

function LeadsPage() {
  const { primaryKey } = useAuth();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", company: "", title: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<Record<string, string>[] | null>(null);
  const [importFile, setImportFile] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Bulk selection + sequence enrollment
  const [selectedLeads, setSelectedLeads] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([]);
  const [enrollSeqId, setEnrollSeqId] = useState("");
  const [enrollForceMove, setEnrollForceMove] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollResult, setEnrollResult] = useState<{ enrolled: number; total: number; conflicts: number } | null>(null);

  // AI Enrichment (Clay-like)
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichSelected, setEnrichSelected] = useState<string[]>([]);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{ enriched: number; failed: number } | null>(null);

  // Lead Finder (dataset import)
  const [finderOpen, setFinderOpen] = useState(false);
  const [finderDatasetId, setFinderDatasetId] = useState("");
  const [finderPreview, setFinderPreview] = useState<Array<{ email?: string; first_name?: string; last_name?: string; company?: string; title?: string }> | null>(null);
  const [finderTotal, setFinderTotal] = useState<number | null>(null);
  const [finderPreviewing, setFinderPreviewing] = useState(false);
  const [finderImporting, setFinderImporting] = useState(false);

  const [askQuery, setAskQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askResults, setAskResults] = useState<Lead[] | null>(null);

  const askAI = async () => {
    if (!primaryKey?.keyRaw || !askQuery.trim() || asking) return;
    setAsking(true);
    setAskAnswer(null);
    try {
      const res = await api.withKey.post<{ answer: string; leads: Lead[] }>(
        "/v1/ai/ask-leads",
        { query: askQuery.trim() },
        primaryKey.keyRaw,
      );
      setAskAnswer(res.answer);
      setAskResults(res.leads ?? []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't answer that — try rephrasing it.");
      setAskAnswer(null);
      setAskResults(null);
    } finally {
      setAsking(false);
    }
  };

  const clearAsk = () => {
    setAskQuery("");
    setAskAnswer(null);
    setAskResults(null);
  };

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ leads: Lead[]; total: number }>("/v1/leads?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => { setLeads(r.leads ?? []); setTotal(r.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const add = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/leads", {
        email: form.email,
        first_name: form.firstName || undefined,
        last_name: form.lastName || undefined,
        company: form.company || undefined,
        title: form.title || undefined,
      }, primaryKey.keyRaw);
      toast.success("Lead added");
      setAdding(false);
      setForm({ email: "", firstName: "", lastName: "", company: "", title: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      setImportPreview(rows);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const runImport = async () => {
    if (!primaryKey?.keyRaw || !importPreview || importPreview.length === 0) return;
    setImporting(true);
    try {
      const leads = importPreview.map(rowToLead);
      // API accepts up to 400 per call — chunk if needed
      const CHUNK = 400;
      let imported = 0;
      for (let i = 0; i < leads.length; i += CHUNK) {
        const chunk = leads.slice(i, i + CHUNK);
        const res = await fetch("https://api.continuumapi.com/v1/leads/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
          body: JSON.stringify({ leads: chunk }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
        }
        const json = await res.json().catch(() => ({ imported: 0 }));
        imported += (json as { imported?: number }).imported ?? 0;
      }
      toast.success(`${imported.toLocaleString()} leads imported`);
      setImportPreview(null);
      setImportFile("");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const previewDataset = async () => {
    if (!primaryKey?.keyRaw || !finderDatasetId.trim()) return;
    setFinderPreviewing(true);
    setFinderPreview(null);
    setFinderTotal(null);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/leads/import/apify/preview?datasetId=${encodeURIComponent(finderDatasetId.trim())}`, {
        headers: { "X-API-Key": primaryKey.keyRaw },
      });
      const data = await res.json().catch(() => ({})) as { preview?: typeof finderPreview; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setFinderPreview(data.preview ?? []);
      setFinderTotal(data.total ?? null);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setFinderPreviewing(false);
    }
  };

  const runFinderImport = async () => {
    if (!primaryKey?.keyRaw || !finderDatasetId.trim()) return;
    setFinderImporting(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/leads/import/apify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ datasetId: finderDatasetId.trim(), limit: 50000 }),
      });
      const data = await res.json().catch(() => ({})) as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      toast.success(`${(data.imported ?? 0).toLocaleString()} leads imported${data.skipped ? ` (${data.skipped} skipped — no email)` : ""}`);
      setFinderOpen(false);
      setFinderDatasetId("");
      setFinderPreview(null);
      setFinderTotal(null);
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setFinderImporting(false);
    }
  };

  const runEnrich = async () => {
    if (!primaryKey?.keyRaw) return;
    setEnriching(true);
    setEnrichResult(null);
    try {
      const body = enrichSelected.length > 0
        ? { leadIds: enrichSelected }
        : { all: true };
      const res = await fetch("https://api.continuumapi.com/v1/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { enriched?: number; failed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setEnrichResult({ enriched: data.enriched ?? 0, failed: data.failed ?? 0 });
      toast.success(`${data.enriched ?? 0} leads enriched with AI personalization`);
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setEnriching(false);
    }
  };

  const openEnrollModal = async () => {
    if (!primaryKey?.keyRaw) return;
    setEnrollOpen(true);
    setEnrollResult(null);
    if (sequences.length === 0) {
      try {
        const r = await api.withKey.get<{ data: { id: string; name: string }[] }>("/v1/sequences?limit=50", primaryKey.keyRaw);
        const seqs = (r.data ?? []).filter((s) => (s as { status?: string }).status !== "archived");
        setSequences(seqs);
        if (seqs.length > 0) setEnrollSeqId(seqs[0]!.id);
      } catch {}
    }
  };

  const doEnroll = async () => {
    if (!primaryKey?.keyRaw || !enrollSeqId) return;
    const emails = selectedLeads.length > 0
      ? leads.filter((l) => selectedLeads.includes(l.id)).map((l) => l.email)
      : leads.map((l) => l.email);
    setEnrolling(true);
    setEnrollResult(null);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${enrollSeqId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ emails, force_move: enrollForceMove }),
      });
      const data = await res.json().catch(() => ({})) as { enrolled?: number; total?: number; conflicts?: unknown[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setEnrollResult({ enrolled: data.enrolled ?? 0, total: data.total ?? emails.length, conflicts: (data.conflicts ?? []).length });
      if ((data.enrolled ?? 0) > 0) {
        toast.success(`${data.enrolled} lead${(data.enrolled ?? 0) === 1 ? "" : "s"} enrolled in sequence`);
        setSelectedLeads([]);
      }
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setEnrolling(false);
    }
  };

  const toggleSelect = (id: string) =>
    setSelectedLeads((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const toggleSelectAll = () =>
    setSelectedLeads((prev) => prev.length === leads.length ? [] : leads.map((l) => l.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">Cold outreach contacts — separate from newsletter subscribers.</p>
        </header>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileSelect} />
          {selectedLeads.length > 0 && (
            <Button variant="outline" size="sm" className="gap-1.5 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30" onClick={openEnrollModal}>
              <GitBranch className="h-4 w-4" />
              Enroll {selectedLeads.length} in sequence
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setFinderOpen((o) => !o); setFinderPreview(null); }}>
            <Search className="h-4 w-4" /> Find Leads
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setEnrichOpen((o) => !o); setEnrichResult(null); }}>
            <Sparkles className="h-4 w-4" /> Enrich with AI
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Import CSV
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add Lead</Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-violet-500 shrink-0" />
          <input
            value={askQuery}
            onChange={(e) => setAskQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") askAI(); }}
            placeholder='Ask in plain English — "who are my top 10 leads", "interested leads at companies with acme in the name"…'
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            disabled={asking}
          />
          {askQuery && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={clearAsk}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" className="gap-1.5 shrink-0" onClick={askAI} disabled={asking || !askQuery.trim()}>
            {asking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            Ask
          </Button>
        </div>

        {askAnswer && (
          <div className="pt-3 border-t border-border space-y-3">
            <p className="text-sm text-muted-foreground">{askAnswer}</p>
            {askResults && askResults.length > 0 && (
              <div className="rounded-md border border-border divide-y divide-border overflow-hidden">
                {askResults.map((l) => (
                  <button
                    key={l.id}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                    onClick={() => navigate({ to: "/dashboard/leads/$id", params: { id: l.email } })}
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-medium">{[l.firstName, l.lastName].filter(Boolean).join(" ") || l.email}</span>
                      {l.company && <span className="text-xs text-muted-foreground ml-2">{l.company}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={l.status} />
                      <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]">{l.email}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {enrichOpen && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-2xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-violet-500" />Enrich with AI</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Generates <code className="bg-muted px-1 rounded">{"{{icebreaker}}"}</code>, <code className="bg-muted px-1 rounded">{"{{company_description}}"}</code>, and <code className="bg-muted px-1 rounded">{"{{pain_point}}"}</code> for each lead. Use these variables in your sequence email templates.
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => { setEnrichOpen(false); setEnrichSelected([]); setEnrichResult(null); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1.5">
            <p className="font-medium text-foreground">What gets generated per lead:</p>
            <p><span className="font-mono text-violet-600 dark:text-violet-400">{"{{icebreaker}}"}</span> — A personalised opening line referencing their role or company</p>
            <p><span className="font-mono text-violet-600 dark:text-violet-400">{"{{company_description}}"}</span> — What the company likely does in one sentence</p>
            <p><span className="font-mono text-violet-600 dark:text-violet-400">{"{{pain_point}}"}</span> — A specific challenge common to their role</p>
          </div>

          {enrichResult && (
            <div className="rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-3 py-2 text-sm text-green-800 dark:text-green-300">
              ✓ {enrichResult.enriched} leads enriched{enrichResult.failed > 0 ? ` · ${enrichResult.failed} failed` : ""}.
              Use <code className="bg-green-100 dark:bg-green-900 px-1 rounded">{"{{icebreaker}}"}</code> etc. in your sequence step templates.
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={runEnrich} disabled={enriching} className="gap-1.5">
              {enriching
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Enriching…</>
                : <><Sparkles className="h-3.5 w-3.5" /> Enrich {enrichSelected.length > 0 ? `${enrichSelected.length} selected` : "all"} leads (up to 50)</>}
            </Button>
            {enrichSelected.length > 0 && (
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setEnrichSelected([])}>Clear selection</Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Processes up to 50 leads per run. Existing variables are preserved.</p>
        </div>
      )}

      {finderOpen && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Find Leads</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Paste a dataset ID from your lead source. All rows with an email column are imported.</p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => { setFinderOpen(false); setFinderPreview(null); setFinderDatasetId(""); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              className="font-mono text-sm"
              placeholder="Dataset ID (e.g. abc123XYZ)"
              value={finderDatasetId}
              onChange={(e) => { setFinderDatasetId(e.target.value); setFinderPreview(null); }}
              onKeyDown={(e) => e.key === "Enter" && previewDataset()}
            />
            <Button variant="outline" onClick={previewDataset} disabled={finderPreviewing || !finderDatasetId.trim()}>
              {finderPreviewing ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Checking…</> : "Preview"}
            </Button>
          </div>

          {finderPreview && (
            <>
              {finderPreview.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rows with an email column found in this dataset.</p>
              ) : (
                <>
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/40 text-muted-foreground border-b border-border">
                          <th className="px-3 py-2 text-left font-medium">Email</th>
                          <th className="px-3 py-2 text-left font-medium">Name</th>
                          <th className="px-3 py-2 text-left font-medium">Company</th>
                          <th className="px-3 py-2 text-left font-medium">Title</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finderPreview.map((row, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="px-3 py-1.5 font-mono">{row.email ?? "—"}</td>
                            <td className="px-3 py-1.5">{[row.first_name, row.last_name].filter(Boolean).join(" ") || "—"}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{row.company ?? "—"}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{row.title ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Showing first 5 rows{finderTotal != null ? ` of ~${finderTotal.toLocaleString()} total` : ""}. All rows with an email will be imported.
                    </p>
                    <Button onClick={runFinderImport} disabled={finderImporting} className="gap-1.5 shrink-0">
                      {finderImporting
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…</>
                        : <><Upload className="h-3.5 w-3.5" /> Import Leads</>}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-lg">
          <h2 className="text-sm font-semibold">Add Lead</h2>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input placeholder="cto@company.com" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First name</Label>
              <Input placeholder="John" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name</Label>
              <Input placeholder="Doe" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Input placeholder="Acme Corp" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input placeholder="CTO" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={add} disabled={saving}>{saving ? "Adding…" : "Add Lead"}</Button>
            <Button variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-3xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{importFile}</p>
                <p className="text-xs text-muted-foreground">{importPreview.length.toLocaleString()} leads found</p>
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
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Company</th>
                  <th className="px-3 py-2 text-left font-medium">Title</th>
                </tr>
              </thead>
              <tbody>
                {importPreview.slice(0, 5).map((row, i) => {
                  const l = rowToLead(row);
                  return (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5 font-mono">{l.email}</td>
                      <td className="px-3 py-1.5">{[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{l.company ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{l.title ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {importPreview.length > 5 && (
              <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
                + {(importPreview.length - 5).toLocaleString()} more rows
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Expected columns: <code className="bg-muted rounded px-1">email</code>, <code className="bg-muted rounded px-1">first_name</code>, <code className="bg-muted rounded px-1">last_name</code>, <code className="bg-muted rounded px-1">company</code>, <code className="bg-muted rounded px-1">title</code>
          </p>
          <div className="flex gap-2">
            <Button onClick={runImport} disabled={importing} className="gap-1.5">
              {importing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…</> : <><Upload className="h-3.5 w-3.5" /> Import {importPreview.length.toLocaleString()} Leads</>}
            </Button>
            <Button variant="outline" onClick={() => { setImportPreview(null); setImportFile(""); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Enroll in Sequence modal */}
      {enrollOpen && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 max-w-lg">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <GitBranch className="h-4 w-4 text-indigo-500" />
                Enroll in Sequence
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectedLeads.length > 0
                  ? `Enrolling ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? "" : "s"}`
                  : `Enrolling all ${total.toLocaleString()} leads`} in the chosen sequence.
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => { setEnrollOpen(false); setEnrollResult(null); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>Sequence</Label>
            {sequences.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sequences found. Create one in the Outbound tab.</p>
            ) : (
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={enrollSeqId}
                onChange={(e) => setEnrollSeqId(e.target.value)}
              >
                {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enrollForceMove} onChange={(e) => setEnrollForceMove(e.target.checked)} className="rounded" />
            <span className="text-xs text-muted-foreground">Force move — remove from any other active sequence first</span>
          </label>
          {enrollResult && (
            <div className={`rounded-md px-3 py-2 text-sm ${enrollResult.enrolled > 0 ? "bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300" : "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"}`}>
              {enrollResult.enrolled > 0
                ? `✓ ${enrollResult.enrolled} lead${enrollResult.enrolled === 1 ? "" : "s"} enrolled.`
                : "No new leads enrolled."}
              {enrollResult.conflicts > 0 && ` ${enrollResult.conflicts} skipped — already in another sequence (enable Force Move to override).`}
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={doEnroll} disabled={enrolling || sequences.length === 0 || !enrollSeqId} className="gap-1.5">
              {enrolling ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Enrolling…</> : <><GitBranch className="h-3.5 w-3.5" /> Enroll leads</>}
            </Button>
            <Button variant="outline" onClick={() => { setEnrollOpen(false); setEnrollResult(null); }}>Done</Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">Total leads:</span>
        <span className="font-semibold tabular-nums">{total.toLocaleString()}</span>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="px-5 py-3 flex items-center gap-4">
              <div className="h-3 w-36 bg-muted rounded animate-pulse" />
              <div className="h-3 w-24 bg-muted rounded animate-pulse" />
              <div className="h-5 w-16 bg-muted rounded-full animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No leads yet. Add individually or import a CSV.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-3 py-3 w-8">
                  <button type="button" onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground">
                    {selectedLeads.length === leads.length && leads.length > 0
                      ? <CheckSquare className="h-4 w-4" />
                      : <Square className="h-4 w-4" />}
                  </button>
                </th>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Company</th>
                <th className="px-5 py-3 font-medium">Title</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Tags</th>
                <th className="px-5 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className={`border-b border-border last:border-0 hover:bg-muted/10 transition-colors cursor-pointer ${selectedLeads.includes(l.id) ? "bg-indigo-50/30 dark:bg-indigo-950/10" : ""}`} onClick={() => navigate({ to: "/dashboard/leads/$id", params: { id: l.id } })}>
                  <td className="px-3 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(l.id); }}>
                    {selectedLeads.includes(l.id)
                      ? <CheckSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                      : <Square className="h-4 w-4 text-muted-foreground hover:text-foreground" />}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">{l.email}</td>
                  <td className="px-5 py-3">{[l.firstName, l.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td className="px-5 py-3 text-muted-foreground">{l.company ?? "—"}</td>
                  <td className="px-5 py-3 text-muted-foreground">{l.title ?? "—"}</td>
                  <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                  <select
                    className="rounded border border-input bg-background px-2 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={l.status}
                    onChange={async (e) => {
                      const newStatus = e.target.value;
                      const prevStatus = l.status;
                      if (!primaryKey?.keyRaw) return;
                      setLeads((prev) => prev.map((x) => x.id === l.id ? { ...x, status: newStatus } : x));
                      try {
                        const res = await fetch(`https://api.continuumapi.com/v1/leads/${l.id}/status`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
                          body: JSON.stringify({ status: newStatus }),
                        });
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}));
                          throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
                        }
                      } catch (e: unknown) {
                        setLeads((prev) => prev.map((x) => x.id === l.id ? { ...x, status: prevStatus } : x));
                        toast.error((e as Error).message);
                      }
                    }}
                  >
                    {["active","interested","not_interested","replied","unsubscribed","bounced","do_not_contact"].map((s) => (
                      <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1">
                      {(l.tags ?? []).slice(0, 3).map(t => (
                        <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-xs">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{new Date(l.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
