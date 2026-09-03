import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
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
} from "lucide-react";

export const Route = createFileRoute("/dashboard/finder")({
  head: () => ({ meta: [{ title: "Lead Finder — Continuum" }] }),
  component: FinderPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchFilters {
  titles: string[];
  companies: string[];
  industries: string[];
  locations: string[];
  headcountMin?: number;
  headcountMax?: number;
  keywords: string;
  limit: number;
}

interface FinderResult {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  location: string | null;
}

type SearchPhase = "idle" | "running" | "succeeded" | "failed";

const INDUSTRIES = [
  "SaaS",
  "FinTech",
  "HealthTech",
  "E-commerce",
  "Marketing",
  "HR",
  "Security",
  "Education",
  "Real Estate",
  "Logistics",
  "Legal",
  "Media",
  "Manufacturing",
  "Consulting",
  "Other",
];

const HEADCOUNT_OPTIONS: { label: string; min?: number; max?: number }[] = [
  { label: "Any" },
  { label: "1–10", min: 1, max: 10 },
  { label: "11–50", min: 11, max: 50 },
  { label: "51–200", min: 51, max: 200 },
  { label: "201–500", min: 201, max: 500 },
  { label: "501–2000", min: 501, max: 2000 },
  { label: "2000+", min: 2000 },
];

const PAGE_SIZE = 50;

// ─── Tag input ────────────────────────────────────────────────────────────────

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
      <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        {label}
      </Label>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-foreground/10 px-2 py-0.5 text-xs font-medium"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <Input
        value={draft}
        placeholder={placeholder}
        className="h-8 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(); }
          if (e.key === "," || e.key === "Tab") { e.preventDefault(); add(); }
        }}
        onBlur={add}
      />
    </div>
  );
}

// ─── Multi-select (checkbox list) ─────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(opt: string) {
    onChange(
      selected.includes(opt) ? selected.filter((x) => x !== opt) : [...selected, opt],
    );
  }

  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        {label}
      </Label>
      <div className="rounded-lg border border-border bg-background max-h-36 overflow-y-auto divide-y divide-border/50">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors text-left"
          >
            {selected.includes(opt) ? (
              <CheckSquare className="h-3.5 w-3.5 shrink-0 text-foreground" />
            ) : (
              <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={selected.includes(opt) ? "text-foreground font-medium" : "text-muted-foreground"}>
              {opt}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function FinderPage() {
  const { primaryKey } = useAuth();

  // Filters
  const [titles, setTitles] = useState<string[]>([]);
  const [company, setCompany] = useState("");
  const [industries, setIndustries] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [headcountKey, setHeadcountKey] = useState("Any");
  const [keywords, setKeywords] = useState("");
  const [limit, setLimit] = useState(100);

  // Search state
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [results, setResults] = useState<FinderResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); // 0-based

  // Selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Poll for status ────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "running" || !runId) return;

    pollRef.current = setInterval(async () => {
      try {
        const data = await api.get<{ status: string; datasetId?: string }>(
          `/v1/finder/jobs/${runId}/status`,
        );
        if (data.status === "succeeded") {
          clearInterval(pollRef.current!);
          setPhase("succeeded");
          fetchPage(runId, 0);
        } else if (data.status === "failed") {
          clearInterval(pollRef.current!);
          setPhase("failed");
        }
      } catch {
        clearInterval(pollRef.current!);
        setPhase("failed");
      }
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [phase, runId]);

  // ── Fetch a results page ───────────────────────────────────────────────────
  async function fetchPage(rid: string, pg: number) {
    try {
      const data = await api.get<{ results: FinderResult[]; total: number }>(
        `/v1/finder/jobs/${rid}/results?offset=${pg * PAGE_SIZE}&limit=${PAGE_SIZE}`,
      );
      setResults(data.results);
      setTotal(data.total);
      setPage(pg);
      setSelected(new Set());
    } catch {
      toast.error("Failed to load results.");
    }
  }

  // ── Start search ───────────────────────────────────────────────────────────
  async function handleSearch() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase("running");
    setResults([]);
    setTotal(0);
    setPage(0);
    setSelected(new Set());

    const hc = HEADCOUNT_OPTIONS.find((o) => o.label === headcountKey);
    const body: SearchFilters & Record<string, unknown> = {
      titles,
      companies: company.trim() ? [company.trim()] : [],
      industries,
      locations,
      keywords: keywords.trim(),
      limit,
    };
    if (hc?.min !== undefined) body.headcountMin = hc.min;
    if (hc?.max !== undefined) body.headcountMax = hc.max;

    try {
      const data = await api.post<{ runId: string }>("/v1/finder/search", body);
      setRunId(data.runId);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? "Failed to start search.";
      toast.error(msg);
      setPhase("idle");
    }
  }

  // ── Import selected ────────────────────────────────────────────────────────
  async function handleImport() {
    if (!runId || selected.size === 0) return;
    setImporting(true);
    try {
      const globalIndices = [...selected].map((i) => page * PAGE_SIZE + i);
      const data = await api.post<{ imported: number; skipped: number }>(
        `/v1/finder/jobs/${runId}/import`,
        { indices: globalIndices },
      );
      toast.success(`${data.imported} lead${data.imported !== 1 ? "s" : ""} imported successfully`);
      setSelected(new Set());
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  // ── Select all on current page ─────────────────────────────────────────────
  const allOnPage = results.map((_, i) => i);
  const allSelected = allOnPage.length > 0 && allOnPage.every((i) => selected.has(i));

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allOnPage));
    }
  }

  function toggleRow(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-6 min-h-[calc(100vh-10rem)]">
      {/* ── Left sidebar: filters ─────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 space-y-5">
        <div>
          <h1 className="text-base font-semibold">Find People</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Filter by role, company, and more — then import directly as leads.
          </p>
        </div>

        <TagInput
          label="Job Title"
          placeholder="e.g. CTO — press Enter to add"
          values={titles}
          onChange={setTitles}
        />

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Company
          </Label>
          <Input
            value={company}
            placeholder="e.g. Acme Corp"
            className="h-8 text-sm"
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>

        <MultiSelect
          label="Industry"
          options={INDUSTRIES}
          selected={industries}
          onChange={setIndustries}
        />

        <TagInput
          label="Location"
          placeholder="e.g. United States — press Enter"
          values={locations}
          onChange={setLocations}
        />

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Headcount
          </Label>
          <select
            value={headcountKey}
            onChange={(e) => setHeadcountKey(e.target.value)}
            className="w-full h-8 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30"
          >
            {HEADCOUNT_OPTIONS.map((o) => (
              <option key={o.label} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Keywords
          </Label>
          <Input
            value={keywords}
            placeholder="Optional — e.g. Series B"
            className="h-8 text-sm"
            onChange={(e) => setKeywords(e.target.value)}
          />
        </div>

        <div>
          <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Result limit
          </Label>
          <Input
            type="number"
            min={1}
            max={1000}
            value={limit}
            className="h-8 text-sm"
            onChange={(e) => setLimit(Math.min(1000, Math.max(1, parseInt(e.target.value || "100", 10))))}
          />
        </div>

        <Button
          className="w-full"
          onClick={handleSearch}
          disabled={phase === "running"}
        >
          {phase === "running" ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching…</>
          ) : (
            <><Search className="h-4 w-4 mr-2" /> Find People</>
          )}
        </Button>
      </aside>

      {/* ── Main area: results ───────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {/* ── Idle ──────────────────────────────────────────────────────────── */}
        {phase === "idle" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border bg-muted/10">
            <Users className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No search yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Use the filters to find leads, then click Find People.
            </p>
          </div>
        )}

        {/* ── Running / polling ─────────────────────────────────────────────── */}
        {phase === "running" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-border bg-muted/5">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm font-medium">Finding people matching your criteria…</p>
            <p className="text-xs text-muted-foreground mt-1">
              This typically takes 1–2 minutes. Hang tight.
            </p>
          </div>
        )}

        {/* ── Failed ────────────────────────────────────────────────────────── */}
        {phase === "failed" && (
          <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-destructive/40 bg-destructive/5">
            <p className="text-sm font-medium text-destructive">Search failed</p>
            <p className="text-xs text-muted-foreground mt-1">
              Something went wrong. Adjust your filters and try again.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setPhase("idle")}
            >
              Reset
            </Button>
          </div>
        )}

        {/* ── Results ───────────────────────────────────────────────────────── */}
        {phase === "succeeded" && (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {total > 0
                  ? `${total.toLocaleString()} result${total !== 1 ? "s" : ""} found`
                  : "No results found — try broader filters."}
                {selected.size > 0 && (
                  <span className="ml-2 font-medium text-foreground">
                    · {selected.size} selected
                  </span>
                )}
              </p>
              {selected.size > 0 && (
                <Button
                  size="sm"
                  onClick={handleImport}
                  disabled={importing}
                >
                  {importing ? (
                    <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Importing…</>
                  ) : (
                    `Import ${selected.size} lead${selected.size !== 1 ? "s" : ""}`
                  )}
                </Button>
              )}
            </div>

            {results.length > 0 && (
              <>
                {/* Table */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/20">
                      <tr>
                        <th className="w-10 px-3 py-2.5 text-left">
                          <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground">
                            {allSelected ? (
                              <CheckSquare className="h-4 w-4 text-foreground" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </button>
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Title</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Company</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Location</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Email</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {results.map((r, i) => {
                        const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || "—";
                        return (
                          <tr
                            key={i}
                            className={`hover:bg-muted/10 transition-colors cursor-pointer ${selected.has(i) ? "bg-muted/20" : ""}`}
                            onClick={() => toggleRow(i)}
                          >
                            <td className="px-3 py-2.5">
                              {selected.has(i) ? (
                                <CheckSquare className="h-4 w-4 text-foreground" />
                              ) : (
                                <Square className="h-4 w-4 text-muted-foreground" />
                              )}
                            </td>
                            <td className="px-4 py-2.5 font-medium text-foreground whitespace-nowrap">{name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[160px] truncate">{r.title ?? "—"}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[160px] truncate">{r.company ?? "—"}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[160px] truncate">{r.location ?? "—"}</td>
                            <td className="px-4 py-2.5 text-muted-foreground max-w-[180px]">
                              {r.email ? (
                                <span className="font-mono text-xs truncate block">{r.email}</span>
                              ) : (
                                <span className="text-muted-foreground/50">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Page {page + 1} of {totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page === 0}
                        onClick={() => fetchPage(runId!, page - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages - 1}
                        onClick={() => fetchPage(runId!, page + 1)}
                      >
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
