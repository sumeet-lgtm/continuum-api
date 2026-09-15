import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Bot, ChevronDown, ChevronRight, Send, Ban, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { AgentActivityFeed } from "@/components/AgentActivityFeed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/nurture-agent")({
  head: () => ({ meta: [{ title: "Nurture Agent — Continuum" }] }),
  component: NurtureAgentPage,
});

interface AgentRun {
  id: string;
  name: string | null;
  status: string;
  config: {
    listId: string;
    about: string;
    fromName: string;
    fromEmail: string;
    autoSend?: boolean;
    draft?: { subject: string; htmlBody: string; textBody: string; matchCount: number };
    campaignId?: string;
  };
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface MailingList {
  id: string;
  name: string;
  contactCount: number;
}

const TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "direct", label: "Direct" },
  { value: "technical", label: "Technical" },
];

function NurtureAgentPage() {
  const { apiKey } = useApiKey();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Create-dialog form state
  const [listId, setListId] = useState("");
  const [about, setAbout] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [tone, setTone] = useState<string>("");
  const [autoSend, setAutoSend] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!apiKey?.keyRaw) { setLoading(false); return; }
    setLoading(true);
    try {
      const [runsRes, listsRes] = await Promise.all([
        api.withKey.get<{ data: AgentRun[] }>("/v1/agent-runs?pillar=nurture", apiKey.keyRaw),
        api.withKey.get<{ data: MailingList[] }>("/v1/lists", apiKey.keyRaw),
      ]);
      setRuns(runsRes.data ?? []);
      setLists(listsRes.data ?? []);
    } catch {
      toast.error("Couldn't load the nurture agent — check your connection");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const create = async () => {
    if (!apiKey?.keyRaw || !listId || !about.trim() || !fromName.trim() || !fromEmail.trim()) return;
    setCreating(true);
    try {
      await api.withKey.post(
        "/v1/agent-runs",
        { pillar: "nurture", listId, about, fromName, fromEmail, autoSend, ...(tone && { tone }) },
        apiKey.keyRaw,
      );
      toast.success("Drafting now — check back in a moment to review.");
      setOpen(false);
      setListId(""); setAbout(""); setFromName(""); setFromEmail(""); setTone(""); setAutoSend(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the agent");
    }
    setCreating(false);
  };

  const approve = async (run: AgentRun) => {
    if (!apiKey?.keyRaw) return;
    if (!confirm(`Send this to ${run.config.draft?.matchCount.toLocaleString() ?? "the"} contacts now? This cannot be undone.`)) return;
    setActing(run.id);
    try {
      await api.withKey.post(`/v1/agent-runs/${run.id}/approve`, {}, apiKey.keyRaw);
      toast.success("Approved — sending now.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't approve the send");
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

  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background shrink-0">
            <Bot className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-medium tracking-tight">Nurture Agent</h1>
            <p className="text-sm text-muted-foreground">
              Give it a topic — it drafts, targets, and (with your approval) sends. Real sending always goes through the same pipeline as a hand-built campaign.
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!apiKey}>
          <Plus className="h-4 w-4 mr-1.5" /> New draft
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
            <p className="text-sm text-muted-foreground">No nurture agent runs yet.</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Give it a topic and a list — it drafts real copy grounded in your actual audience, then waits for your approval before anything sends.
            </p>
            <Button size="sm" onClick={() => setOpen(true)} className="mt-1" disabled={!apiKey}>
              <Plus className="h-4 w-4 mr-1.5" /> New draft
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">List / draft</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Recipients</th>
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
                          <span className="text-xs font-medium block">{r.config.draft?.subject || r.name || listName(r.config.listId)}</span>
                          <span className="text-[11px] text-muted-foreground">{listName(r.config.listId)}</span>
                        </div>
                        {r.config.autoSend && (
                          <span className="text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">auto-send</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                      {r.errorMessage && <p className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {r.config.draft?.matchCount != null ? r.config.draft.matchCount.toLocaleString() : "—"}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {r.status === "pending_approval" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => approve(r)} disabled={acting === r.id}>
                              <Send className="h-3.5 w-3.5 mr-1" /> Approve &amp; send
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => reject(r)} disabled={acting === r.id}>
                              <Ban className="h-3.5 w-3.5 mr-1" /> Discard
                            </Button>
                          </>
                        )}
                        {r.status === "completed" && r.config.campaignId && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Sent
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-detail`} className="border-b border-border last:border-0 bg-muted/10">
                      <td colSpan={5} className="p-0">
                        {r.config.draft && (
                          <div className="px-5 py-4 border-b border-border space-y-2">
                            <p className="text-xs font-medium">Subject: {r.config.draft.subject}</p>
                            <div className="text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto border border-border rounded-md p-3 bg-background">
                              {r.config.draft.textBody}
                            </div>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New nurture draft</DialogTitle>
            <DialogDescription>
              Drafts copy grounded in this list's real audience signal. Nothing sends until you approve it below (unless you turn on auto-send).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Mailing list</Label>
              <Select value={listId} onValueChange={setListId}>
                <SelectTrigger><SelectValue placeholder="Who is this for?" /></SelectTrigger>
                <SelectContent>
                  {lists.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name} ({l.contactCount.toLocaleString()} contacts)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>What's this about?</Label>
              <Textarea
                placeholder="e.g. we just shipped inbox placement scoring — tell existing customers what it does and how to try it"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>From name</Label>
                <Input placeholder="Acme Inc." value={fromName} onChange={(e) => setFromName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>From email</Label>
                <Input placeholder="hello@acme.com" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Tone (optional)</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger><SelectValue placeholder="Let the agent choose" /></SelectTrigger>
                <SelectContent>
                  {TONES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
              <div>
                <p className="text-xs font-medium">Auto-send once drafted</p>
                <p className="text-[11px] text-muted-foreground">Off by default — review the draft yourself before it sends.</p>
              </div>
              <Switch checked={autoSend} onCheckedChange={setAutoSend} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!listId || !about.trim() || !fromName.trim() || !fromEmail.trim() || creating}>
              {creating ? "Starting…" : "Draft it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
