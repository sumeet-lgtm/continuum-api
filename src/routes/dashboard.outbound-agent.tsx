import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, ChevronDown, ChevronRight, Send, Ban, CheckCircle2, Users } from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard/outbound-agent")({
  head: () => ({ meta: [{ title: "Outbound Agent — Continuum" }] }),
  component: OutboundAgentPage,
});

interface AgentRun {
  id: string;
  name: string | null;
  status: string;
  config: {
    leadIds: string[];
    about: string;
    draft?: { sequenceName: string; steps: Array<{ subject: string; textBody: string; delayDays: number }>; matchCount: number };
    sequenceId?: string;
  };
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

function OutboundAgentPage() {
  const { apiKey } = useApiKey();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    if (!apiKey?.keyRaw) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await api.withKey.get<{ data: AgentRun[] }>("/v1/agent-runs?pillar=outbound", apiKey.keyRaw);
      setRuns(res.data ?? []);
    } catch {
      toast.error("Couldn't load the outbound agent — check your connection");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const approve = async (run: AgentRun) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm(`Enroll ${run.config.draft?.matchCount.toLocaleString() ?? "these"} leads and start sending? This is real cold outreach and cannot be undone.`)) return;
    setActing(run.id);
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/approve`, {}, apiKey.keyRaw);
      toast.success("Approved — leads enrolled, sending on schedule.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't approve the sequence");
    }
    setActing(null);
    await load();
  };

  const reject = async (run: AgentRun) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm("Discard this draft? It won't be sent.")) return;
    setActing(run.id);
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/cancel`, {}, apiKey.keyRaw);
    } catch {
      toast.error("Couldn't discard the draft");
    }
    setActing(null);
    await load();
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background shrink-0">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-medium tracking-tight">Outbound Agent</h1>
            <p className="text-sm text-muted-foreground">
              Drafts multi-step cold sequences for leads you select. Real sends always require your approval here first — no exceptions, no auto-send.
            </p>
          </div>
        </div>
        <Link to="/dashboard/leads">
          <Button variant="outline" size="sm" className="gap-1.5">
            <Users className="h-4 w-4" /> Select leads to draft from
          </Button>
        </Link>
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
            <p className="text-sm text-muted-foreground">No outbound agent drafts yet.</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Select leads on the Leads page and choose "Draft with Outbound Agent" — it grounds the copy in their real title/company/industry and waits here for your review.
            </p>
            <Link to="/dashboard/leads">
              <Button size="sm" className="mt-1 gap-1.5"><Users className="h-4 w-4" /> Go to Leads</Button>
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">Draft</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Leads</th>
                <th className="px-5 py-2 font-medium">Created</th>
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
                          <span className="text-xs font-medium block">{r.config.draft?.sequenceName || r.name || "Untitled sequence"}</span>
                          {r.config.draft && <span className="text-[11px] text-muted-foreground">{r.config.draft.steps.length} steps</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                      {r.errorMessage && <p className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.config.draft?.matchCount != null ? r.config.draft.matchCount.toLocaleString() : r.config.leadIds.length}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {r.status === "pending_approval" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => approve(r)} disabled={acting === r.id}>
                              <Send className="h-3.5 w-3.5 mr-1" /> Approve &amp; enroll
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => reject(r)} disabled={acting === r.id}>
                              <Ban className="h-3.5 w-3.5 mr-1" /> Discard
                            </Button>
                          </>
                        )}
                        {r.status === "completed" && r.config.sequenceId && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Enrolled
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-detail`} className="border-b border-border last:border-0 bg-muted/10">
                      <td colSpan={5} className="p-0">
                        {r.config.draft && (
                          <div className="px-5 py-4 border-b border-border space-y-3">
                            {r.config.draft.steps.map((step, i) => (
                              <div key={i} className="text-xs">
                                <p className="font-medium">Step {i + 1}{step.delayDays > 0 ? ` (+${step.delayDays}d)` : ""}: {step.subject}</p>
                                <p className="text-muted-foreground whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto border border-border rounded-md p-2 bg-background">{step.textBody}</p>
                              </div>
                            ))}
                          </div>
                        )}
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
    </div>
  );
}
