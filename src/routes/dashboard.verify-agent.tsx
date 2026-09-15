import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Bot, PlayCircle, PauseCircle, Ban, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/verify-agent")({
  head: () => ({ meta: [{ title: "Verification Agent — Continuum" }] }),
  component: VerificationAgentPage,
});

interface AgentRun {
  id: string;
  name: string | null;
  status: string;
  config: { listId: string; autoRemoveInvalid?: boolean; cutoffDays?: number };
  intervalHours: number | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  isPaused: boolean;
  errorMessage: string | null;
}

interface MailingList {
  id: string;
  name: string;
  contactCount: number;
}

const INTERVALS = [1, 6, 12, 24, 48, 72, 168];

function VerificationAgentPage() {
  const { apiKey } = useApiKey();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Create-dialog form state
  const [listId, setListId] = useState("");
  const [interval, setInterval] = useState(24);
  const [autoRemove, setAutoRemove] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!apiKey?.keyRaw) { setLoading(false); return; }
    setLoading(true);
    try {
      const [runsRes, listsRes] = await Promise.all([
        api.withKey.get<{ data: AgentRun[] }>("/v1/agent-runs?pillar=verification", apiKey.keyRaw),
        api.withKey.get<{ data: MailingList[] }>("/v1/lists", apiKey.keyRaw),
      ]);
      setRuns(runsRes.data ?? []);
      setLists(listsRes.data ?? []);
    } catch {
      toast.error("Couldn't load verification agent — check your connection");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const create = async () => {
    if (!apiKey?.keyRaw || !listId) return;
    setCreating(true);
    try {
      await api.withKey.post(
        "/v1/agent-runs",
        { listId, intervalHours: interval, autoRemoveInvalid: autoRemove },
        apiKey.keyRaw,
      );
      toast.success("Verification agent created — first check runs within the hour.");
      setOpen(false);
      setListId("");
      setInterval(24);
      setAutoRemove(false);
      await load();
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
    if (!confirm(`Cancel this watch? It will stop ticking permanently.`)) return;
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/cancel`, {}, apiKey.keyRaw);
    } catch {
      toast.error("Couldn't cancel the agent");
      return;
    }
    await load();
  };

  const triggerNow = async (run: AgentRun) => {
    if (!apiKey?.keyRaw) return;
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/trigger`, {}, apiKey.keyRaw);
      toast.success("Triggered — processing shortly.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't trigger the agent");
    }
  };

  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background shrink-0">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-medium tracking-tight">Verification Agent</h1>
            <p className="text-sm text-muted-foreground">
              Watches a mailing list continuously — re-verifies stale or new contacts on its own, no manual re-upload.
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
            <p className="text-sm text-muted-foreground">No verification agents yet.</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Point it at a mailing list and it'll keep every contact's verification status fresh automatically — flagging or quarantining invalid ones as they show up.
            </p>
            <Button size="sm" onClick={() => setOpen(true)} className="mt-1" disabled={!apiKey}>
              <Plus className="h-4 w-4 mr-1.5" /> New watch
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">List</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Interval</th>
                <th className="px-5 py-2 font-medium">Last checked</th>
                <th className="px-5 py-2 font-medium">Next check</th>
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
                        <span className="text-xs font-medium">{r.name || listName(r.config.listId)}</span>
                        {r.config.autoRemoveInvalid && (
                          <span className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">auto-quarantine</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                      {r.errorMessage && <p className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{r.intervalHours ?? "—"}h</td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.status === "cancelled" ? "—" : r.nextCheckAt ? new Date(r.nextCheckAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {r.status !== "cancelled" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => triggerNow(r)} disabled={r.isPaused} title="Run a tick now">
                              <PlayCircle className="h-3.5 w-3.5 mr-1" /> Check now
                            </Button>
                            {r.isPaused ? (
                              <Button variant="ghost" size="sm" onClick={() => setStatus(r, "active")}>Resume</Button>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => setStatus(r, "paused")}>
                                <PauseCircle className="h-3.5 w-3.5 mr-1" /> Pause
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => cancel(r)}>
                              <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-feed`} className="border-b border-border last:border-0 bg-muted/10">
                      <td colSpan={6} className="p-0">
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New verification agent</DialogTitle>
            <DialogDescription>
              Picks up new and stale contacts on this list automatically — no manual CSV re-upload.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Mailing list</Label>
              <Select value={listId} onValueChange={setListId}>
                <SelectTrigger><SelectValue placeholder="Choose a list to watch" /></SelectTrigger>
                <SelectContent>
                  {lists.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name} ({l.contactCount.toLocaleString()} contacts)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {lists.length === 0 && (
                <p className="text-xs text-muted-foreground">No mailing lists yet — create one under Nurture &amp; Newsletters first.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Check interval</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {INTERVALS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setInterval(h)}
                    className={`rounded-md border px-2 py-1.5 text-xs ${
                      interval === h
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-card hover:bg-muted"
                    }`}
                  >
                    {h}h
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
              <div>
                <p className="text-xs font-medium">Auto-quarantine invalid contacts</p>
                <p className="text-[11px] text-muted-foreground">Off by default — flags invalid contacts without removing them from active sending.</p>
              </div>
              <Switch checked={autoRemove} onCheckedChange={setAutoRemove} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!listId || creating}>
              {creating ? "Creating…" : "Create watch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
