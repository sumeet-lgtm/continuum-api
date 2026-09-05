import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Search,
  X,
  Loader2,
  Users,
  CheckSquare,
  Square,
  ChevronLeft,
  ChevronRight,
  Download,
  Mail,
  ShieldCheck,
  Linkedin,
  FileDown,
  Bookmark,
  BookmarkCheck,
  Trash2,
  Zap,
  TrendingUp,
  Briefcase,
  Building2,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/finder")({
  head: () => ({ meta: [{ title: "Lead Finder — Continuum" }] }),
  component: FinderPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinderResult {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  location: string | null;
  phone: string | null;
  companyDomain: string | null;
  companySize: string | null;
  companyIndustry: string | null;
  seniority: string | null;
  emailStatus: string | null;
  responseSignal: "high" | "medium" | "low";
}

type SearchPhase = "idle" | "searching" | "verifying" | "succeeded" | "failed";

// Pipeline Labs enum values
const SENIORITY_OPTIONS = [
  { value: "c_suite", label: "C-Suite" },
  { value: "vp", label: "VP" },
  { value: "director", label: "Director" },
  { value: "manager", label: "Manager" },
  { value: "senior", label: "Senior" },
  { value: "entry", label: "Entry" },
  { value: "owner", label: "Owner" },
  { value: "partner", label: "Partner" },
  { value: "intern", label: "Intern" },
];

const DEPARTMENT_OPTIONS = [
  { value: "engineering", label: "Engineering" },
  { value: "sales", label: "Sales" },
  { value: "marketing", label: "Marketing" },
  { value: "finance", label: "Finance" },
  { value: "operations", label: "Operations" },
  { value: "human_resources", label: "Human Resources" },
  { value: "information_technology", label: "IT" },
  { value: "business_development", label: "Biz Dev" },
  { value: "support", label: "Support" },
  { value: "consulting", label: "Consulting" },
  { value: "education", label: "Education" },
];

const HEADCOUNT_OPTIONS = [
  { value: "1-10", label: "1–10" },
  { value: "11-50", label: "11–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-500", label: "201–500" },
  { value: "501-1000", label: "501–1,000" },
  { value: "1001-5000", label: "1K–5K" },
  { value: "5001-10000", label: "5K–10K" },
  { value: "10001+", label: "10,000+" },
];

const PAGE_SIZE = 50;
const SAVED_KEY = "continuum_finder_saved_searches";

interface SavedSearch {
  id: string;
  name: string;
  filters: {
    personTitleIncludes: string[];
    seniorityIncludes: string[];
    functionIncludes: string[];
    companyIndustryIncludes: string[];
    personLocationCountryIncludes: string[];
    personLocationCityIncludes: string[];
    companyNameIncludes: string[];
    companyDomainIncludes: string[];
    companySizeIncludes: string[];
    companyKeywordIncludes: string[];
    technologiesIncludes: string[];
    hasEmail: boolean;
    totalResults: number;
  };
}

function loadSavedSearches(): SavedSearch[] {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"); } catch { return []; }
}
function persistSavedSearches(s: SavedSearch[]) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(s)); } catch {}
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TagInput({
  label,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const t = draft.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft("");
  }

  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">{label}</Label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-md bg-foreground/10 px-2 py-0.5 text-xs font-medium">
              {v}
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        placeholder={placeholder}
        className="h-8 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === "Tab") { e.preventDefault(); add(); }
        }}
        onBlur={add}
      />
    </div>
  );
}

function PillSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }
  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
              selected.includes(o.value)
                ? "bg-foreground text-background border-foreground"
                : "bg-transparent text-muted-foreground border-border hover:border-foreground/40"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function FinderPage() {
  const navigate = useNavigate();
  // Filters
  const [personTitleIncludes, setPersonTitleIncludes] = useState<string[]>([]);
  const [seniorityIncludes, setSeniorityIncludes] = useState<string[]>([]);
  const [functionIncludes, setFunctionIncludes] = useState<string[]>([]);
  const [companyIndustryIncludes, setCompanyIndustryIncludes] = useState<string[]>([]);
  const [personLocationCountryIncludes, setPersonLocationCountryIncludes] = useState<string[]>([]);
  const [personLocationCityIncludes, setPersonLocationCityIncludes] = useState<string[]>([]);
  const [companyNameIncludes, setCompanyNameIncludes] = useState<string[]>([]);
  const [companyDomainIncludes, setCompanyDomainIncludes] = useState<string[]>([]);
  const [companySizeIncludes, setCompanySizeIncludes] = useState<string[]>([]);
  const [companyKeywordIncludes, setCompanyKeywordIncludes] = useState<string[]>([]);
  const [technologiesIncludes, setTechnologiesIncludes] = useState<string[]>([]);
  const [hasEmail, setHasEmail] = useState(true);
  const [totalResults, setTotalResults] = useState(100);
  const [minResponseSignal, setMinResponseSignal] = useState<"all" | "medium" | "high">("all");

  // Search state
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [results, setResults] = useState<FinderResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyJobId, setVerifyJobId] = useState<string | null>(null);
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);
  // Sequence picker — loaded once when results arrive
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([]);
  const [targetSequenceId, setTargetSequenceId] = useState<string>("");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Saved searches ──────────────────────────────────────────────────────────
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(loadSavedSearches);
  const [savingSearch, setSavingSearch] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState("");

  const currentFilters = useCallback(() => ({
    personTitleIncludes, seniorityIncludes, functionIncludes,
    companyIndustryIncludes, personLocationCountryIncludes,
    personLocationCityIncludes, companyNameIncludes, companyDomainIncludes,
    companySizeIncludes, companyKeywordIncludes, technologiesIncludes,
    hasEmail, totalResults,
  }), [personTitleIncludes, seniorityIncludes, functionIncludes,
    companyIndustryIncludes, personLocationCountryIncludes, personLocationCityIncludes,
    companyNameIncludes, companyDomainIncludes, companySizeIncludes,
    companyKeywordIncludes, technologiesIncludes, hasEmail, totalResults]);

  const saveCurrentSearch = () => {
    const name = saveSearchName.trim();
    if (!name) return;
    const entry: SavedSearch = { id: Date.now().toString(), name, filters: currentFilters() };
    const next = [entry, ...savedSearches];
    setSavedSearches(next);
    persistSavedSearches(next);
    setSaveSearchName("");
    setSavingSearch(false);
    toast.success(`Saved "${name}"`);
  };

  const loadSavedSearch = (s: SavedSearch) => {
    const f = s.filters;
    setPersonTitleIncludes(f.personTitleIncludes);
    setSeniorityIncludes(f.seniorityIncludes);
    setFunctionIncludes(f.functionIncludes);
    setCompanyIndustryIncludes(f.companyIndustryIncludes);
    setPersonLocationCountryIncludes(f.personLocationCountryIncludes);
    setPersonLocationCityIncludes(f.personLocationCityIncludes);
    setCompanyNameIncludes(f.companyNameIncludes);
    setCompanyDomainIncludes(f.companyDomainIncludes);
    setCompanySizeIncludes(f.companySizeIncludes);
    setCompanyKeywordIncludes(f.companyKeywordIncludes);
    setTechnologiesIncludes(f.technologiesIncludes);
    setHasEmail(f.hasEmail);
    setTotalResults(f.totalResults);
    toast.success(`Loaded "${s.name}"`);
  };

  const deleteSavedSearch = (id: string) => {
    const next = savedSearches.filter((s) => s.id !== id);
    setSavedSearches(next);
    persistSavedSearches(next);
  };

  // Poll for status — handles two phases: searching → verifying → succeeded
  useEffect(() => {
    if ((phase !== "searching" && phase !== "verifying") || !runId) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.get<{
          status: string;
          phase?: string;
          verifyJobId?: string;
          progress?: number;
          total?: number;
        }>(`/v1/finder/jobs/${runId}/status`);

        if (data.status === "failed") {
          clearInterval(pollRef.current!);
          setPhase("failed");
          return;
        }

        if (data.phase === "searching") {
          setPhase("searching");
          return;
        }

        if (data.phase === "verifying") {
          setPhase("verifying");
          if (data.verifyJobId) setVerifyJobId(data.verifyJobId);
          if (data.progress !== undefined && data.total) {
            setVerifyProgress({ done: data.progress, total: data.total });
          }
          return;
        }

        if (data.status === "succeeded") {
          clearInterval(pollRef.current!);
          if (data.verifyJobId) setVerifyJobId(data.verifyJobId);
          setPhase("succeeded");
          fetchPage(runId, 0, data.verifyJobId ?? undefined);
        }
      } catch {
        clearInterval(pollRef.current!);
        setPhase("failed");
      }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, runId]);

  async function fetchPage(rid: string, pg: number, vjId?: string) {
    try {
      const vjParam = vjId ? `&verifyJobId=${vjId}` : "";
      const data = await api.get<{ results: FinderResult[]; total: number; rawTotal?: number; isVerified?: boolean }>(
        `/v1/finder/jobs/${rid}/results?offset=${pg * PAGE_SIZE}&limit=${PAGE_SIZE}${vjParam}`,
      );
      setResults(data.results);
      setTotal(data.total);
      setPage(pg);
      setSelected(new Set());
    } catch {
      toast.error("Failed to load results.");
    }
    // Load sequences once so user can pick one to enroll into
    if (sequences.length === 0) {
      try {
        const seqData = await api.get<{ data?: { id: string; name: string }[] }>("/v1/sequences");
        setSequences(seqData.data ?? []);
      } catch { /* non-fatal */ }
    }
  }

  async function handleSearch() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase("searching");
    setResults([]);
    setTotal(0);
    setPage(0);
    setSelected(new Set());
    setVerifyJobId(null);
    setVerifyProgress(null);

    // Build payload with only non-empty filters
    const payload: Record<string, unknown> = { totalResults: Math.min(totalResults, 2500) };
    if (personTitleIncludes.length) payload.personTitleIncludes = personTitleIncludes;
    if (seniorityIncludes.length) payload.seniorityIncludes = seniorityIncludes;
    if (functionIncludes.length) payload.functionIncludes = functionIncludes;
    if (companyIndustryIncludes.length) payload.companyIndustryIncludes = companyIndustryIncludes;
    if (personLocationCountryIncludes.length) payload.personLocationCountryIncludes = personLocationCountryIncludes;
    if (personLocationCityIncludes.length) payload.personLocationCityIncludes = personLocationCityIncludes;
    if (companyNameIncludes.length) payload.companyNameIncludes = companyNameIncludes;
    if (companyDomainIncludes.length) payload.companyDomainIncludes = companyDomainIncludes;
    if (companySizeIncludes.length) payload.companySizeIncludes = companySizeIncludes;
    if (companyKeywordIncludes.length) payload.companyKeywordIncludes = companyKeywordIncludes;
    if (technologiesIncludes.length) payload.technologiesIncludes = technologiesIncludes;
    payload.hasEmail = hasEmail;

    try {
      const data = await api.post<{ runId: string; totalResultsUsed: number; cappedByQuota: boolean }>("/v1/finder/search", payload);
      setRunId(data.runId);
      if (data.cappedByQuota) {
        toast.warning(`Searching for ${data.totalResultsUsed} results instead of ${totalResults} — that's what's left of your monthly verification quota.`);
      }
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? "Failed to start search.");
      setPhase("idle");
    }
  }

  async function handleVerify() {
    if (!runId) return;
    setVerifying(true);
    try {
      const data = await api.post<{ jobId: string | null; total?: number; message?: string }>(
        `/v1/finder/jobs/${runId}/verify`,
        {},
      );
      if (data.jobId) {
        toast.success(`Verifying ${data.total} emails — check Verify → Jobs for results.`);
      } else {
        toast.info(data.message ?? "No emails to verify.");
      }
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleImport(importAll = false) {
    if (!runId) return;
    if (!importAll && selected.size === 0) return;
    setImporting(true);
    try {
      const base: Record<string, unknown> = {};
      if (verifyJobId) base.verifyJobId = verifyJobId;
      if (targetSequenceId) base.sequenceId = targetSequenceId;

      const body = importAll
        ? { ...base, importAll: true }
        : { ...base, emails: [...selected].map((i) => filteredResults[i]?.email).filter(Boolean) };

      const data = await api.post<{ imported: number; skipped: number }>(
        `/v1/finder/jobs/${runId}/import`,
        body,
      );
      const count = data.imported;
      if (targetSequenceId) {
        const seqName = sequences.find((s) => s.id === targetSequenceId)?.name ?? "sequence";
        toast.success(`${count} lead${count !== 1 ? "s" : ""} added to "${seqName}"`, {
          action: {
            label: "Open Sequence",
            onClick: () => navigate({ to: "/dashboard/sequences" }),
          },
        });
      } else {
        toast.success(`${count} lead${count !== 1 ? "s" : ""} saved to Leads`, {
          action: { label: "View Leads", onClick: () => navigate({ to: "/dashboard/leads" }) },
        });
      }
      setSelected(new Set());
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function exportCsv() {
    const rows = filteredResults.length > 0 ? filteredResults : [];
    if (rows.length === 0) return;
    const headers = ["First Name","Last Name","Email","Title","Company","Company Domain","Location","Company Size","Industry","Seniority","Response Signal","LinkedIn URL"];
    const lines = [
      headers.join(","),
      ...rows.map((r) => [
        r.firstName ?? "",
        r.lastName ?? "",
        r.email ?? "",
        r.title ?? "",
        r.company ?? "",
        r.companyDomain ?? "",
        r.location ?? "",
        r.companySize ?? "",
        r.companyIndustry ?? "",
        r.seniority ?? "",
        r.responseSignal,
        r.linkedinUrl ?? "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "continuum-finder-export.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const SIGNAL_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };
  const filteredResults = minResponseSignal === "all"
    ? results
    : results.filter((r) => (SIGNAL_RANK[r.responseSignal] ?? 0) >= SIGNAL_RANK[minResponseSignal]);

  const allOnPage = filteredResults.map((_, i) => i);
  const allSelected = allOnPage.length > 0 && allOnPage.every((i) => selected.has(i));
  function toggleSelectAll() { setSelected(allSelected ? new Set() : new Set(allOnPage)); }
  function toggleRow(i: number) {
    setSelected((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col md:flex-row gap-6 min-h-[calc(100vh-10rem)]">
      {/* ── Sidebar: filters ───────────────────────────────────────────────── */}
      <aside className="w-full md:w-72 shrink-0 space-y-5 overflow-y-auto pr-1">
        <div>
          <h1 className="text-base font-semibold">Find People</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            250M+ verified B2B contacts. Filter and import directly as leads.
          </p>
        </div>

        <TagInput label="Job Title" placeholder="e.g. VP of Engineering — Enter to add" values={personTitleIncludes} onChange={setPersonTitleIncludes} />

        <PillSelect label="Seniority" options={SENIORITY_OPTIONS} selected={seniorityIncludes} onChange={setSeniorityIncludes} />

        <PillSelect label="Department" options={DEPARTMENT_OPTIONS} selected={functionIncludes} onChange={setFunctionIncludes} />

        <TagInput label="Industry" placeholder="e.g. Computer Software, Financial Services — Enter to add" values={companyIndustryIncludes} onChange={setCompanyIndustryIncludes} />

        <div className="space-y-2">
          <TagInput label="Country" placeholder="e.g. United States — Enter to add" values={personLocationCountryIncludes} onChange={setPersonLocationCountryIncludes} />
          <TagInput label="City" placeholder="e.g. San Francisco — Enter to add" values={personLocationCityIncludes} onChange={setPersonLocationCityIncludes} />
        </div>

        <TagInput label="Company Name" placeholder="e.g. Salesforce — Enter to add" values={companyNameIncludes} onChange={setCompanyNameIncludes} />

        <TagInput label="Company Domain" placeholder="e.g. salesforce.com — Enter to add" values={companyDomainIncludes} onChange={setCompanyDomainIncludes} />

        <PillSelect label="Company Size" options={HEADCOUNT_OPTIONS} selected={companySizeIncludes} onChange={setCompanySizeIncludes} />

        <TagInput label="Company Keywords" placeholder="e.g. Series B, AI — Enter to add" values={companyKeywordIncludes} onChange={setCompanyKeywordIncludes} />

        <TagInput label="Technologies Used" placeholder="e.g. Salesforce, HubSpot" values={technologiesIncludes} onChange={setTechnologiesIncludes} />

        {/* Intent Signals — Apollo parity */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            <Label className="text-xs font-medium text-muted-foreground">Intent Signals</Label>
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">Click to add as company keyword signal</p>
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "Recently hired", icon: Briefcase, keyword: "recently hired" },
              { label: "Hiring now", icon: TrendingUp, keyword: "hiring" },
              { label: "Series A/B", icon: TrendingUp, keyword: "Series B" },
              { label: "Raised funding", icon: Building2, keyword: "raised funding" },
              { label: "Expanding", icon: TrendingUp, keyword: "expanding" },
              { label: "New office", icon: Building2, keyword: "new office" },
            ].map(({ label, icon: Icon, keyword }) => {
              const active = companyKeywordIncludes.includes(keyword);
              return (
                <button
                  key={keyword}
                  type="button"
                  onClick={() => setCompanyKeywordIncludes((prev) =>
                    active ? prev.filter((k) => k !== keyword) : [...prev, keyword]
                  )}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs border transition-colors ${active ? "bg-amber-500/20 border-amber-500/40 text-amber-600 dark:text-amber-400" : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Response signal filter */}
        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Min. Response Signal</Label>
          <div className="flex gap-1.5">
            {(["all", "medium", "high"] as const).map((sig) => (
              <button
                key={sig}
                type="button"
                onClick={() => { setMinResponseSignal(sig); setSelected(new Set()); }}
                className={`flex-1 h-7 rounded-md text-xs border transition-colors ${minResponseSignal === sig
                  ? sig === "high" ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                  : sig === "medium" ? "bg-amber-500/20 border-amber-500/40 text-amber-600 dark:text-amber-400"
                  : "bg-foreground/10 border-foreground/30 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30"}`}
              >
                {sig === "all" ? "Any" : sig.charAt(0).toUpperCase() + sig.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between py-1">
          <Label className="text-xs font-medium text-muted-foreground">Must have email</Label>
          <button
            type="button"
            onClick={() => setHasEmail((v) => !v)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${hasEmail ? "bg-foreground" : "bg-muted"}`}
          >
            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform ${hasEmail ? "translate-x-4" : "translate-x-0"}`} />
          </button>
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Max results <span className="text-muted-foreground/60">(≤ 2,500)</span>
          </Label>
          <Input
            type="number"
            min={1}
            max={2500}
            value={totalResults}
            className="h-8 text-sm"
            onChange={(e) => setTotalResults(Math.min(2500, Math.max(1, parseInt(e.target.value || "100", 10))))}
          />
        </div>

        {/* Saved searches */}
        {savedSearches.length > 0 && (
          <div>
            <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Saved Searches</Label>
            <div className="space-y-1">
              {savedSearches.map((s) => (
                <div key={s.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 group hover:bg-muted/20">
                  <button
                    type="button"
                    className="flex-1 text-left text-xs font-medium truncate"
                    onClick={() => loadSavedSearch(s)}
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSavedSearch(s.id)}
                    className="shrink-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {savingSearch ? (
          <div className="flex gap-1.5">
            <Input
              autoFocus
              value={saveSearchName}
              placeholder="Search name…"
              className="h-8 text-sm flex-1"
              onChange={(e) => setSaveSearchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurrentSearch();
                if (e.key === "Escape") setSavingSearch(false);
              }}
            />
            <Button size="sm" className="h-8 px-3" onClick={saveCurrentSearch}>Save</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={() => setSavingSearch(true)}>
            <Bookmark className="h-3.5 w-3.5" /> Save this search
          </Button>
        )}

        <Button className="w-full" onClick={handleSearch} disabled={phase === "searching" || phase === "verifying"}>
          {phase === "searching" ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching…</>
          ) : phase === "verifying" ? (
            <><ShieldCheck className="h-4 w-4 mr-2" /> Verifying…</>
          ) : (
            <><Search className="h-4 w-4 mr-2" /> Find People</>
          )}
        </Button>
      </aside>

      {/* ── Main: results ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {phase === "idle" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border bg-muted/10">
            <Users className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No search yet</p>
            <p className="text-xs text-muted-foreground mt-1">Set your filters and click Find People.</p>
          </div>
        )}

        {phase === "searching" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-border bg-muted/5">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm font-medium">Searching 250M+ contacts…</p>
            <p className="text-xs text-muted-foreground mt-1">Usually takes 1–2 minutes.</p>
            <div className="mt-4 flex items-center gap-2">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-foreground animate-pulse" />
              <span className="text-xs text-muted-foreground">Step 1 of 2 — finding matches</span>
            </div>
          </div>
        )}

        {phase === "verifying" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-border bg-muted/5">
            <ShieldCheck className="h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">Verifying email deliverability…</p>
            <p className="text-xs text-muted-foreground mt-1">
              Running real SMTP checks on each address. Bounces never reach your list.
            </p>
            {verifyProgress && (
              <div className="mt-4 w-48">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>{verifyProgress.done.toLocaleString()} checked</span>
                  <span>{verifyProgress.total.toLocaleString()} total</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-foreground/60 rounded-full transition-all"
                    style={{ width: `${Math.round((verifyProgress.done / verifyProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Step 2 of 2 — SMTP verification</span>
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-destructive/40 bg-destructive/5">
            <p className="text-sm font-medium text-destructive">Search failed</p>
            <p className="text-xs text-muted-foreground mt-1">Adjust your filters and try again.</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setPhase("idle")}>Reset</Button>
          </div>
        )}

        {phase === "succeeded" && (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <p className="text-sm text-muted-foreground shrink-0">
                {total > 0
                  ? <><span className="font-medium text-foreground">{total.toLocaleString()}</span> verified result{total !== 1 ? "s" : ""}</>
                  : "No results — try broader filters."}
                {selected.size > 0 && <span className="ml-2 text-foreground">· {selected.size} selected</span>}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Sequence picker */}
                {total > 0 && (
                  <select
                    value={targetSequenceId}
                    onChange={(e) => setTargetSequenceId(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">Save to Leads</option>
                    {sequences.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}
                {results.length > 0 && (
                  <Button variant="outline" size="sm" onClick={exportCsv}>
                    <FileDown className="h-3.5 w-3.5 mr-1.5" />
                    Export CSV
                  </Button>
                )}
                {total > 0 && (
                  <Button variant="outline" size="sm" onClick={() => handleImport(true)} disabled={importing}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Import all {total.toLocaleString()}
                  </Button>
                )}
                {selected.size > 0 && (
                  <Button size="sm" onClick={() => handleImport(false)} disabled={importing}>
                    {importing ? (
                      <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Importing…</>
                    ) : (
                      <><Mail className="h-3.5 w-3.5 mr-1.5" />Import {selected.size}</>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {results.length > 0 && (
              <>
                <div className="rounded-xl border border-border overflow-x-auto">
                  <table className="w-full text-sm min-w-[700px]">
                    <thead className="bg-muted/20">
                      <tr>
                        <th className="w-10 px-3 py-2.5 text-left">
                          <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground">
                            {allSelected ? <CheckSquare className="h-4 w-4 text-foreground" /> : <Square className="h-4 w-4" />}
                          </button>
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Title</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Company</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Location</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Email</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Size</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">LinkedIn</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Signal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredResults.map((r, i) => {
                        const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || "—";
                        const signalStyles: Record<string, string> = {
                          high: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                          medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                          low: "bg-muted/40 text-muted-foreground",
                        };
                        return (
                          <tr
                            key={i}
                            className={`hover:bg-muted/10 transition-colors cursor-pointer ${selected.has(i) ? "bg-muted/20" : ""}`}
                            onClick={() => toggleRow(i)}
                          >
                            <td className="px-3 py-2.5">
                              {selected.has(i) ? <CheckSquare className="h-4 w-4 text-foreground" /> : <Square className="h-4 w-4 text-muted-foreground" />}
                            </td>
                            <td className="px-4 py-2.5 font-medium text-foreground whitespace-nowrap">{name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[160px] truncate">{r.title ?? "—"}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[160px] truncate">{r.company ?? "—"}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[140px] truncate">{r.location ?? "—"}</td>
                            <td className="px-4 py-2.5 max-w-[180px]">
                              {r.email ? (
                                <span className="font-mono text-xs text-muted-foreground truncate block">{r.email}</span>
                              ) : (
                                <span className="text-muted-foreground/40 text-xs">no email</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">{r.companySize ?? "—"}</td>
                            <td className="px-4 py-2.5">
                              {r.linkedinUrl ? (
                                <a
                                  href={r.linkedinUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:underline"
                                >
                                  <Linkedin className="h-3 w-3" /> Profile
                                </a>
                              ) : (
                                <span className="text-muted-foreground/40 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${signalStyles[r.responseSignal] ?? signalStyles.low}`}>
                                {r.responseSignal}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</p>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => fetchPage(runId!, page - 1)}>
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => fetchPage(runId!, page + 1)}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
