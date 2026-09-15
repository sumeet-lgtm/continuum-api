import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Bot, ChevronDown, ChevronRight, PauseCircle, Ban } from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/warmup-agent")({
  head: () => ({ meta: [{ title: "Warmup Agent — Continuum" }] }),
  component: WarmupAgentPage,
});

interface AgentRun {
  id: string;
  name: string | null;
  status: string;
  config: { mailboxId: string; baselineDailyRampUp: number };
  lastCheckedAt: string | null;
  isPaused: boolean;
  errorMessage: string | null;
}

interface WarmupConfig { enabled: boolean; currentPerDay: number; targetPerDay: number; dailyRampUp?: number }
interface Mailbox { id: string; username: string; status: string; warmupConfig?: WarmupConfig | null }

function WarmupAgentPage() {
  const { apiKey } = useApiKey();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!apiKey?.keyRaw) { setLoading(false); return; }
    setLoading(true);
    try {
      const [runsRes, mbRes] = await Promise.all([
        api.withKey.get<{ data: AgentRun[] }>("/v1/agent-runs?pillar=warmup", apiKey.keyRaw),
        api.withKey.get<{ data: Mailbox[] }>("/v1/mailboxes", apiKey.keyRaw),
      ]);
      setRuns(runsRes.data ?? []);
      setMailboxes(mbRes.data ?? []);
    } catch {
      toast.error("Couldn't load the warmup agent — check your connection");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  // Only mailboxes with warmup already enabled, and no active agent yet.
  const watchedMailboxIds = new Set(runs.filter((r) => r.status !== "cancelled").map((r) => r.config.mailboxId));
  const eligibleMailboxes = mailboxes.filter((m) => m.warmupConfig?.enabled && !watchedMailboxIds.has(m.id));

  const create = async () => {
    if (!apiKey?.keyRaw || !mailboxId) return;
    setCreating(true);
    try {
      const created = await api.withKey.post<AgentRun>("/v1/agent-runs", { pillar: "warmup", mailboxId }, apiKey.keyRaw);
      toast.success("Warmup agent created — checks in daily.");
      setOpen(false);
      setMailboxId("");
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
    if (!confirm("Stop this warmup agent? The mailbox keeps warming up on the fixed default schedule instead.")) return;
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/cancel`, {}, apiKey.keyRaw);
    } catch {
      toast.error("Couldn't cancel the agent");
      return;
    }
    await load();
  };

  const mailboxFor = (id: string) => mailboxes.find((m) => m.id === id);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background shrink-0">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-medium tracking-tight">Warmup Agent</h1>
            <p className="text-sm text-muted-foreground">
              Checks each mailbox daily and holds the ramp on any sign of trouble, instead of blindly increasing volume through it.
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!apiKey || eligibleMailboxes.length === 0}>
          <Plus className="h-4 w-4 mr-1.5" /> Watch a mailbox
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
            <p className="text-sm text-muted-foreground">No warmup agents yet.</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {mailboxes.some((m) => m.warmupConfig?.enabled)
                ? "Pick a mailbox that already has warmup enabled — the agent takes over deciding its daily ramp rate from real health signals."
                : "Enable warmup on a mailbox under Mailboxes first, then come back here to hand its ramp-rate decisions to the agent."}
            </p>
            {eligibleMailboxes.length > 0 && (
              <Button size="sm" onClick={() => setOpen(true)} className="mt-1">
                <Plus className="h-4 w-4 mr-1.5" /> Watch a mailbox
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">Mailbox</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Warmup progress</th>
                <th className="px-5 py-2 font-medium">Last checked</th>
                <th className="px-5 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const mb = mailboxFor(r.config.mailboxId);
                return (
                  <>
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3 cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        <div className="flex items-center gap-1.5">
                          {expanded === r.id ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                          <span className="text-xs font-mono">{mb?.username ?? r.config.mailboxId}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={r.status} />
                        {r.errorMessage && <p className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">
                        {mb?.warmupConfig ? `${mb.warmupConfig.currentPerDay} / ${mb.warmupConfig.targetPerDay} per day` : "—"}
                      </td>
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Watch a mailbox</DialogTitle>
            <DialogDescription>
              Checks in daily and holds the ramp if the mailbox's status or last send shows trouble, instead of increasing volume regardless.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Mailbox</Label>
              <Select value={mailboxId} onValueChange={setMailboxId}>
                <SelectTrigger><SelectValue placeholder="Choose a warmup-enabled mailbox" /></SelectTrigger>
                <SelectContent>
                  {eligibleMailboxes.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eligibleMailboxes.length === 0 && (
                <p className="text-xs text-muted-foreground">No eligible mailboxes — enable warmup on one under Mailboxes first.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!mailboxId || creating}>
              {creating ? "Creating…" : "Create watch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
