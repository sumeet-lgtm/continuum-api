import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, GitBranch, Play, Pause, Users, X, ChevronDown, ChevronRight, Clock, Trash2, Copy } from "lucide-react";

export const Route = createFileRoute("/dashboard/sequences")({
  head: () => ({ meta: [{ title: "Sequences — Continuum API" }] }),
  component: SequencesPage,
});

interface SequenceStep {
  id: string;
  stepOrder: number;
  delayDays: number;
  delayHours: number;
  subject: string;
  htmlBody: string;
  condition: string;
}

interface Sequence {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  status: string;
  trackOpens: boolean;
  stopOnReply: boolean;
  createdAt: string;
  _count?: { steps: number; enrollments: number };
}

const CONDITION_LABELS: Record<string, string> = {
  always: "Always send",
  if_not_opened: "Only if not opened",
  if_opened: "Only if opened",
  if_not_clicked: "Only if not clicked",
  if_not_replied: "Only if not replied",
};

function SequencesPage() {
  const { primaryKey } = useAuth();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "" });
  const [saving, setSaving] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<Sequence | null>(null);
  const [enrollEmails, setEnrollEmails] = useState("");
  const [enrolling, setEnrolling] = useState(false);

  // Step management state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, SequenceStep[]>>({});
  const [stepsLoading, setStepsLoading] = useState<string | null>(null);
  const [addingStep, setAddingStep] = useState<string | null>(null);
  const [stepForm, setStepForm] = useState({ delayDays: "1", delayHours: "0", subject: "", htmlBody: "", condition: "always" });
  const [stepSaving, setStepSaving] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ sequences: Sequence[] }>("/v1/sequences", primaryKey.keyRaw)
      .then((r) => setSequences(r.data ?? r.sequences ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const loadSteps = async (seqId: string) => {
    if (!primaryKey?.keyRaw) return;
    setStepsLoading(seqId);
    try {
      const r = await api.withKey.get<{ data: SequenceStep[] }>(`/v1/sequences/${seqId}/steps`, primaryKey.keyRaw);
      setSteps((prev) => ({ ...prev, [seqId]: r.data ?? [] }));
    } catch {
      setSteps((prev) => ({ ...prev, [seqId]: [] }));
    } finally {
      setStepsLoading(null);
    }
  };

  const toggleExpand = (seqId: string) => {
    if (expandedId === seqId) {
      setExpandedId(null);
      setAddingStep(null);
    } else {
      setExpandedId(seqId);
      setAddingStep(null);
      if (!steps[seqId]) loadSteps(seqId);
    }
  };

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/sequences", {
        name: form.name,
        from_name: form.fromName,
        from_email: form.fromEmail,
        stop_on_reply: true,
        track_opens: true,
        track_clicks: true,
      }, primaryKey.keyRaw);
      toast.success("Sequence created");
      setCreating(false);
      setForm({ name: "", fromName: "", fromEmail: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (seq: Sequence) => {
    if (!primaryKey?.keyRaw) return;
    const newStatus = seq.status === "active" ? "paused" : "active";
    try {
      await fetch(`https://api.continuumapi.com/v1/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ status: newStatus }),
      });
      setSequences((s) => s.map((x) => x.id === seq.id ? { ...x, status: newStatus } : x));
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const enroll = async () => {
    if (!primaryKey?.keyRaw || !enrollTarget) return;
    const emails = enrollEmails
      .split(/[\n,;]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (emails.length === 0) {
      toast.error("Enter at least one valid email address");
      return;
    }
    setEnrolling(true);
    try {
      await api.withKey.post(`/v1/sequences/${enrollTarget.id}/contacts`, { emails }, primaryKey.keyRaw);
      toast.success(`${emails.length} contact${emails.length > 1 ? "s" : ""} enrolled in "${enrollTarget.name}"`);
      setEnrollTarget(null);
      setEnrollEmails("");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setEnrolling(false);
    }
  };

  const addStep = async (seqId: string) => {
    if (!primaryKey?.keyRaw) return;
    if (!stepForm.subject || !stepForm.htmlBody) {
      toast.error("Subject and body are required");
      return;
    }
    setStepSaving(true);
    try {
      await api.withKey.post(`/v1/sequences/${seqId}/steps`, {
        delay_days: parseInt(stepForm.delayDays) || 0,
        delay_hours: parseInt(stepForm.delayHours) || 0,
        subject: stepForm.subject,
        html_body: stepForm.htmlBody,
        condition: stepForm.condition,
      }, primaryKey.keyRaw);
      toast.success("Step added");
      setAddingStep(null);
      setStepForm({ delayDays: "1", delayHours: "0", subject: "", htmlBody: "", condition: "always" });
      await loadSteps(seqId);
      setSequences((s) => s.map((x) => x.id === seqId ? { ...x, _count: { ...x._count, steps: (x._count?.steps ?? 0) + 1, enrollments: x._count?.enrollments ?? 0 } } : x));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setStepSaving(false);
    }
  };

  const duplicate = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/sequences/${id}/duplicate`, {
        method: "POST",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      toast.success("Sequence duplicated");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const deleteStep = async (seqId: string, stepId: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/sequences/${seqId}/steps/${stepId}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      setSteps((prev) => ({ ...prev, [seqId]: (prev[seqId] ?? []).filter((s) => s.id !== stepId) }));
      setSequences((s) => s.map((x) => x.id === seqId ? { ...x, _count: { ...x._count, steps: Math.max(0, (x._count?.steps ?? 1) - 1), enrollments: x._count?.enrollments ?? 0 } } : x));
      toast.success("Step removed");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">Multi-step cold outreach with conditions, delays, and reply detection.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Sequence
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">New Sequence</h2>
          <div className="space-y-1.5">
            <Label>Sequence name</Label>
            <Input placeholder="Cold Outreach Q4" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From name</Label>
              <Input placeholder="Sumeet" value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>From email</Label>
              <Input placeholder="sumeet@yourapp.com" value={form.fromEmail} onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Sequence"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Enroll modal */}
      {enrollTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Enroll contacts — {enrollTarget.name}</h2>
              <button onClick={() => { setEnrollTarget(null); setEnrollEmails(""); }} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-1.5">
              <Label>Email addresses</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[100px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={"alice@company.com\nbob@company.com\ncharlie@company.com"}
                value={enrollEmails}
                onChange={(e) => setEnrollEmails(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">One per line, or comma-separated. Duplicates and already-enrolled contacts are skipped.</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={enroll} disabled={enrolling || !enrollEmails.trim()} className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                {enrolling ? "Enrolling…" : "Enroll"}
              </Button>
              <Button variant="outline" onClick={() => { setEnrollTarget(null); setEnrollEmails(""); }}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : sequences.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No sequences yet. Create a multi-step cold outreach campaign with conditions and reply detection.</p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Sequence</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq) => (
            <div key={seq.id} className="rounded-lg border border-border bg-card overflow-hidden">
              {/* Header row */}
              <div className="p-5 flex items-center justify-between gap-4">
                <button
                  className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  onClick={() => toggleExpand(seq.id)}
                >
                  {expandedId === seq.id
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  }
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{seq.name}</span>
                      <StatusBadge status={seq.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{seq.fromName} &lt;{seq.fromEmail}&gt;</p>
                  </div>
                </button>
                <div className="flex items-center gap-4 text-sm shrink-0">
                  <div className="text-center">
                    <div className="font-semibold tabular-nums">{seq._count?.steps ?? 0}</div>
                    <div className="text-xs text-muted-foreground">steps</div>
                  </div>
                  <div className="text-center">
                    <div className="font-semibold tabular-nums">{seq._count?.enrollments ?? 0}</div>
                    <div className="text-xs text-muted-foreground">enrolled</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => toggleStatus(seq)}>
                    {seq.status === "active" ? <><Pause className="h-3 w-3" /> Pause</> : <><Play className="h-3 w-3" /> Resume</>}
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => { setEnrollTarget(seq); setEnrollEmails(""); }}>
                    <Users className="h-3 w-3" /> Enroll
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-1" onClick={() => duplicate(seq.id)}>
                    <Copy className="h-3 w-3" /> Dupe
                  </Button>
                </div>
              </div>

              {/* Steps panel */}
              {expandedId === seq.id && (
                <div className="border-t border-border bg-muted/20 p-5 space-y-4">
                  {stepsLoading === seq.id ? (
                    <p className="text-xs text-muted-foreground">Loading steps…</p>
                  ) : (
                    <>
                      {(steps[seq.id] ?? []).length === 0 && addingStep !== seq.id && (
                        <p className="text-xs text-muted-foreground">No steps yet. Add your first email step below.</p>
                      )}
                      {(steps[seq.id] ?? []).map((step, i) => (
                        <div key={step.id} className="flex items-start gap-3">
                          <div className="h-7 w-7 rounded-full bg-muted border border-border flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
                            {step.stepOrder}
                          </div>
                          <div className="flex-1 min-w-0 rounded-md border border-border bg-card p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{step.subject}</p>
                                <div className="flex items-center gap-3 mt-1">
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Clock className="h-3 w-3" />
                                    {i === 0 ? "Immediately" : `${step.delayDays}d${step.delayHours > 0 ? ` ${step.delayHours}h` : ""} delay`}
                                  </span>
                                  {step.condition !== "always" && (
                                    <span className="text-xs text-muted-foreground">{CONDITION_LABELS[step.condition] ?? step.condition}</span>
                                  )}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-destructive shrink-0"
                                onClick={() => deleteStep(seq.id, step.id)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}

                      {/* Add step form */}
                      {addingStep === seq.id ? (
                        <div className="rounded-md border border-border bg-card p-4 space-y-3">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">New Step</p>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Delay (days)</Label>
                              <Input type="number" min="0" value={stepForm.delayDays} onChange={(e) => setStepForm((f) => ({ ...f, delayDays: e.target.value }))} className="h-8 text-sm" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Delay (hours)</Label>
                              <Input type="number" min="0" max="23" value={stepForm.delayHours} onChange={(e) => setStepForm((f) => ({ ...f, delayHours: e.target.value }))} className="h-8 text-sm" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Send condition</Label>
                              <select
                                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                value={stepForm.condition}
                                onChange={(e) => setStepForm((f) => ({ ...f, condition: e.target.value }))}
                              >
                                {Object.entries(CONDITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Subject</Label>
                            <Input placeholder="Quick question about {{company}}" value={stepForm.subject} onChange={(e) => setStepForm((f) => ({ ...f, subject: e.target.value }))} className="h-8 text-sm" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Email body (HTML)</Label>
                            <textarea
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              placeholder={"<p>Hi {{first_name}},</p>\n<p>I noticed {{company}} is growing fast…</p>"}
                              value={stepForm.htmlBody}
                              onChange={(e) => setStepForm((f) => ({ ...f, htmlBody: e.target.value }))}
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => addStep(seq.id)} disabled={stepSaving}>{stepSaving ? "Saving…" : "Add Step"}</Button>
                            <Button size="sm" variant="outline" onClick={() => setAddingStep(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 w-full"
                          onClick={() => { setAddingStep(seq.id); setStepForm({ delayDays: "1", delayHours: "0", subject: "", htmlBody: "", condition: "always" }); }}
                        >
                          <Plus className="h-3.5 w-3.5" /> Add Step
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
