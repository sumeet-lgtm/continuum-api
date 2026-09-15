import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Bot, ChevronDown, ChevronRight, PauseCircle, Ban, X } from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/finder-agent")({
  head: () => ({ meta: [{ title: "Lead Finding Agent — Continuum" }] }),
  component: FinderAgentPage,
});

interface AgentRun {
  id: string;
  name: string | null;
  status: string;
  config: {
    searchFilters: { personTitleIncludes?: string[]; companyIndustryIncludes?: string[]; personLocationCountryIncludes?: string[] };
    sequenceId?: string;
    pendingRunId?: string;
  };
  intervalHours: number | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  isPaused: boolean;
  errorMessage: string | null;
}

interface Sequence { id: string; name: string }

const INTERVALS = [24, 72, 168, 336];
const INTERVAL_LABELS: Record<number, string> = { 24: "Daily", 72: "Every 3 days", 168: "Weekly", 336: "Every 2 weeks" };

function TagInput({ label, placeholder, values, onChange }: { label: string; placeholder: string; values: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  function add() {
    const t = draft.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft("");
  }
  return (
    <div>
      <Label className="text-xs mb-1.5 block">{label}</Label>
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
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "," || e.key === "Tab") { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

function FinderAgentPage() {
  const { apiKey } = useApiKey();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [titles, setTitles] = useState<string[]>([]);
  const [industries, setIndustries] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [totalResults, setTotalResults] = useState(100);
  const [sequenceId, setSequenceId] = useState<string>("");
  const [interval, setInterval] = useState(168);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!apiKey?.keyRaw) { setLoading(false); return; }
    setLoading(true);
    try {
      const [runsRes, seqRes] = await Promise.all([
        api.withKey.get<{ data: AgentRun[] }>("/v1/agent-runs?pillar=lead_finding", apiKey.keyRaw),
        api.withKey.get<{ data: Sequence[] }>("/v1/sequences", apiKey.keyRaw).catch(() => ({ data: [] })),
      ]);
      setRuns(runsRes.data ?? []);
      setSequences(seqRes.data ?? []);
    } catch {
      toast.error("Couldn't load the lead finding agent — check your connection");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const create = async () => {
    if (!apiKey?.keyRaw || titles.length === 0) return;
    setCreating(true);
    try {
      const created = await api.withKey.post<AgentRun>(
        "/v1/agent-runs",
        {
          pillar: "lead_finding",
          searchFilters: {
            personTitleIncludes: titles,
            ...(industries.length > 0 && { companyIndustryIncludes: industries }),
            ...(countries.length > 0 && { personLocationCountryIncludes: countries }),
            totalResults,
          },
          ...(sequenceId && { sequenceId }),
          intervalHours: interval,
        },
        apiKey.keyRaw,
      );
      toast.success("Watch created — first search starts within a few minutes.");
      setOpen(false);
      setTitles([]); setIndustries([]); setCountries([]); setTotalResults(100); setSequenceId(""); setInterval(168);
      setRuns((prev) => [created, ...prev]);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the agent");
    }
    setCreating(false);
  };

  const setStatus = async (run: AgentRun, status: "active" | "paused") => {
    if (!apiKey?.keyRaw) return;
    try {
      await api.withKey.patch(`/v1/agent-runs/${run.id}`, { status }, apiKey.keyRaw);
    } catch {
      toast.error("Couldn't update the agent");
      return;
    }
    await load();
  };

  const cancel = async (run: AgentRun) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm("Stop this watch permanently?")) return;
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/cancel`, {}, apiKey.keyRaw);
    } catch {
      toast.error("Couldn't cancel the agent");
      return;
    }
    await load();
  };

  const sequenceName = (id?: string) => (id ? sequences.find((s) => s.id === id)?.name ?? id : null);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background shrink-0">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-medium tracking-tight">Lead Finding Agent</h1>
            <p className="text-sm text-muted-foreground">
              Save a search once — it re-runs on a schedule and surfaces only new, verified people you haven't seen yet.
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!apiKey}>
          <Plus className="h-4 w-4 mr-1.5" /> New watch
        </Button>
      </header>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        {loading ? (
          <div className="divide-y divide-border">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center gap-4">
                <div className="h-3 w-44 bg-muted rounded animate-pulse" />
                <div className="h-5 w-14 bg-muted rounded-full animate-pulse" />
                <div className="h-3 w-28 bg-muted rounded animate-pulse ml-auto" />
              </div>
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <Bot className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No lead finding agents yet.</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Save a search once and it keeps finding new people who match — imported straight into your Lead CRM, verified, deduped against what you already have.
            </p>
            <Button size="sm" onClick={() => setOpen(true)} className="mt-1" disabled={!apiKey}>
              <Plus className="h-4 w-4 mr-1.5" /> New watch
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">Search</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Cadence</th>
                <th className="px-5 py-2 font-medium">Last run</th>
                <th className="px-5 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <>
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-3 cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                      <div className="flex items-center gap-1.5">
                        {expanded === r.id ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        <div>
                          <span className="text-xs font-medium block">
                            {(r.config.searchFilters.personTitleIncludes ?? []).join(", ") || r.name || "Untitled search"}
                          </span>
                          {sequenceName(r.config.sequenceId) && (
                            <span className="text-[11px] text-muted-foreground">auto-enrolls into {sequenceName(r.config.sequenceId)}</span>
                          )}
                        </div>
                        {r.config.pendingRunId && (
                          <span className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">searching…</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                      {r.errorMessage && <p className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{INTERVAL_LABELS[r.intervalHours ?? 168] ?? `${r.intervalHours}h`}</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleString() : "Not yet"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {r.status !== "cancelled" && (
                          <>
                            {r.isPaused ? (
                              <Button variant="ghost" size="sm" onClick={() => setStatus(r, "active")}>Resume</Button>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => setStatus(r, "paused")}>
                                <PauseCircle className="h-3.5 w-3.5 mr-1" /> Pause
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => cancel(r)}>
                              <Ban className="h-3.5 w-3.5 mr-1" /> Stop
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-feed`} className="border-b border-border last:border-0 bg-muted/10">
                      <td colSpan={5} className="p-0">
                        {apiKey?.keyRaw && <AgentActivityFeed agentRunId={r.id} apiKey={apiKey.keyRaw} />}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New lead finding watch</DialogTitle>
            <DialogDescription>
              Runs on a schedule. Every cycle, only people you haven't already imported get added to your Lead CRM.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <TagInput label="Job title" placeholder="e.g. VP of Engineering — Enter to add" values={titles} onChange={setTitles} />
            <TagInput label="Industry (optional)" placeholder="e.g. Computer Software — Enter to add" values={industries} onChange={setIndustries} />
            <TagInput label="Country (optional)" placeholder="e.g. United States — Enter to add" values={countries} onChange={setCountries} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Results per search</Label>
                <Input type="number" min={1} max={2500} value={totalResults} onChange={(e) => setTotalResults(Math.max(1, Math.min(2500, Number(e.target.value) || 100)))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Search cadence</Label>
                <Select value={String(interval)} onValueChange={(v) => setInterval(Number(v))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((h) => <SelectItem key={h} value={String(h)}>{INTERVAL_LABELS[h]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sequences.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Auto-enroll new leads into (optional)</Label>
                <Select value={sequenceId} onValueChange={setSequenceId}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Don't auto-enroll" /></SelectTrigger>
                  <SelectContent>
                    {sequences.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={titles.length === 0 || creating}>
              {creating ? "Creating…" : "Create watch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
