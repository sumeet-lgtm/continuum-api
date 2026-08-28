import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Zap, ChevronDown, ChevronRight, Clock, Trash2, Play, Pause, Users, X } from "lucide-react";

export const Route = createFileRoute("/dashboard/automations")({
  head: () => ({ meta: [{ title: "Autoresponders — Continuum API" }] }),
  component: AutomationsPage,
});

interface AutomationStep {
  id: string;
  stepOrder: number;
  delayHours: number;
  subject: string;
  htmlBody: string;
  fromName: string | null;
  fromEmail: string | null;
}

interface Automation {
  id: string;
  name: string;
  triggerEvent: string;
  status: string;
  createdAt: string;
  steps: AutomationStep[];
  _count: { enrollments: number };
}

interface Enrollment {
  id: string;
  email: string;
  status: string;
  currentStep: number;
  nextSendAt: string | null;
  enrolledAt: string;
  completedAt: string | null;
}

interface AutomationStats {
  enrollments: { total: number; active: number; completed: number; unsubscribed: number; bounced: number };
  completion_rate: number;
  unsubscribe_rate: number;
}

const TRIGGER_PRESETS = [
  { value: "subscriber.confirmed", label: "Subscriber confirmed (double opt-in)" },
  { value: "subscriber.added", label: "Subscriber added to list" },
  { value: "purchase.completed", label: "Purchase completed" },
  { value: "trial.started", label: "Trial started" },
  { value: "user.registered", label: "User registered" },
  { value: "custom", label: "Custom event…" },
];

interface StepDraft {
  delayHours: string;
  subject: string;
  htmlBody: string;
  fromName: string;
  fromEmail: string;
}

function delayLabel(hours: number, index: number) {
  if (index === 0 && hours === 0) return "Immediately";
  if (hours === 0) return "No delay";
  if (hours < 24) return `${hours}h after previous`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} after previous`;
}

function AutomationsPage() {
  const { primaryKey } = useAuth();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Create form
  const [name, setName] = useState("");
  const [triggerPreset, setTriggerPreset] = useState(TRIGGER_PRESETS[0].value);
  const [triggerCustom, setTriggerCustom] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([
    { delayHours: "0", subject: "", htmlBody: "", fromName: "", fromEmail: "" },
  ]);
  const [saving, setSaving] = useState(false);

  // Expand / drill
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<Record<string, Enrollment[]>>({});
  const [stats, setStats] = useState<Record<string, AutomationStats>>({});
  const [enrollLoading, setEnrollLoading] = useState<string | null>(null);

  // Manual trigger modal
  const [triggerTarget, setTriggerTarget] = useState<Automation | null>(null);
  const [triggerEmail, setTriggerEmail] = useState("");
  const [triggering, setTriggering] = useState(false);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: Automation[] }>("/v1/automations?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setAutomations(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const triggerEvent = triggerPreset === "custom" ? triggerCustom.trim() : triggerPreset;

  const addStep = () =>
    setSteps((s) => [...s, { delayHours: "24", subject: "", htmlBody: "", fromName: "", fromEmail: "" }]);

  const removeStep = (i: number) =>
    setSteps((s) => s.filter((_, idx) => idx !== i));

  const setStep = (i: number, field: keyof StepDraft, val: string) =>
    setSteps((s) => s.map((step, idx) => idx === i ? { ...step, [field]: val } : step));

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!triggerEvent) { toast.error("Trigger event is required"); return; }
    if (steps.some((s) => !s.subject || !s.htmlBody)) {
      toast.error("All steps need a subject and body");
      return;
    }
    setSaving(true);
    try {
      await api.withKey.post("/v1/automations", {
        name: name.trim(),
        trigger_event: triggerEvent,
        steps: steps.map((s) => ({
          delay_hours: parseInt(s.delayHours) || 0,
          subject: s.subject,
          html_body: s.htmlBody,
          ...(s.fromName ? { from_name: s.fromName } : {}),
          ...(s.fromEmail ? { from_email: s.fromEmail } : {}),
        })),
      }, primaryKey.keyRaw);
      toast.success("Autoresponder created");
      setCreating(false);
      setName("");
      setTriggerPreset(TRIGGER_PRESETS[0].value);
      setTriggerCustom("");
      setSteps([{ delayHours: "0", subject: "", htmlBody: "", fromName: "", fromEmail: "" }]);
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (a: Automation) => {
    if (!primaryKey?.keyRaw) return;
    const next = a.status === "active" ? "paused" : "active";
    try {
      await fetch(`https://api.continuumapi.com/v1/automations/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ status: next }),
      });
      setAutomations((prev) => prev.map((x) => x.id === a.id ? { ...x, status: next } : x));
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const del = async (a: Automation) => {
    if (!primaryKey?.keyRaw || !confirm(`Delete "${a.name}"?`)) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/automations/${a.id}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      setAutomations((prev) => prev.filter((x) => x.id !== a.id));
      if (expandedId === a.id) setExpandedId(null);
      toast.success("Deleted");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const expand = async (a: Automation) => {
    if (expandedId === a.id) { setExpandedId(null); return; }
    setExpandedId(a.id);
    if (!primaryKey?.keyRaw) return;
    setEnrollLoading(a.id);
    try {
      const [enr, st] = await Promise.all([
        api.withKey.get<{ data: Enrollment[] }>(`/v1/automations/${a.id}/enrollments?limit=20`, primaryKey.keyRaw),
        api.withKey.get<AutomationStats>(`/v1/automations/${a.id}/stats`, primaryKey.keyRaw),
      ]);
      setEnrollments((prev) => ({ ...prev, [a.id]: enr.data ?? [] }));
      setStats((prev) => ({ ...prev, [a.id]: st }));
    } catch { /* ignore */ }
    finally { setEnrollLoading(null); }
  };

  const unenroll = async (automationId: string, email: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/automations/${automationId}/enrollments/${encodeURIComponent(email)}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      setEnrollments((prev) => ({
        ...prev,
        [automationId]: (prev[automationId] ?? []).map((e) =>
          e.email === email ? { ...e, status: "unsubscribed" } : e
        ),
      }));
      toast.success("Unenrolled");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const triggerManual = async () => {
    if (!primaryKey?.keyRaw || !triggerTarget || !triggerEmail) return;
    setTriggering(true);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/automations/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ event: triggerTarget.triggerEvent, email: triggerEmail.trim() }),
      });
      const data = await res.json().catch(() => null) as { enrolled?: boolean; reason?: string } | null;
      if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `Failed (${res.status})`);
      if (data?.enrolled) {
        toast.success(`Enrolled ${triggerEmail}`);
      } else {
        toast.info(`Not enrolled: ${data?.reason ?? "unknown"}`);
      }
      setTriggerTarget(null);
      setTriggerEmail("");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Autoresponders</h1>
          <p className="text-sm text-muted-foreground">
            Trigger-based email sequences — send a welcome series, onboarding drip, or any workflow when an event fires.
          </p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Autoresponder
        </Button>
      </div>

      {/* Manual trigger modal */}
      {triggerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-sm space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Manually enroll — {triggerTarget.name}</h2>
              <button onClick={() => { setTriggerTarget(null); setTriggerEmail(""); }} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              This fires event <code className="bg-muted rounded px-1">{triggerTarget.triggerEvent}</code> for the address below, enrolling them in all active autoresponders listening to it.
            </p>
            <div className="space-y-1.5">
              <Label>Email address</Label>
              <Input
                type="email"
                placeholder="user@example.com"
                value={triggerEmail}
                onChange={(e) => setTriggerEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") triggerManual(); }}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={triggerManual} disabled={triggering || !triggerEmail} className="gap-1.5">
                <Zap className="h-3.5 w-3.5" />
                {triggering ? "Enrolling…" : "Enroll"}
              </Button>
              <Button variant="outline" onClick={() => { setTriggerTarget(null); setTriggerEmail(""); }}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-5 max-w-2xl">
          <h2 className="text-sm font-semibold">New Autoresponder</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input placeholder="Welcome series" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Trigger event</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={triggerPreset}
                onChange={(e) => setTriggerPreset(e.target.value)}
              >
                {TRIGGER_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              {triggerPreset === "custom" && (
                <Input
                  className="mt-2"
                  placeholder="e.g. order.shipped"
                  value={triggerCustom}
                  onChange={(e) => setTriggerCustom(e.target.value)}
                />
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email steps</p>
              <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={addStep}>
                <Plus className="h-3 w-3" /> Add step
              </Button>
            </div>

            {steps.map((step, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-4 space-y-3 relative">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs whitespace-nowrap">Send after</Label>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min="0"
                          className="h-7 w-16 text-xs text-center"
                          value={step.delayHours}
                          onChange={(e) => setStep(i, "delayHours", e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">hours</span>
                      </div>
                      {parseInt(step.delayHours) >= 24 && (
                        <span className="text-xs text-muted-foreground">
                          ({Math.round(parseInt(step.delayHours) / 24)}d)
                        </span>
                      )}
                    </div>
                  </div>
                  {steps.length > 1 && (
                    <button
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => removeStep(i)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Input
                    placeholder="Subject line"
                    className="text-sm"
                    value={step.subject}
                    onChange={(e) => setStep(i, "subject", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder={"<p>Hi {{first_name}},</p>\n<p>Welcome aboard!</p>"}
                    value={step.htmlBody}
                    onChange={(e) => setStep(i, "htmlBody", e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    placeholder="From name (optional)"
                    className="h-8 text-xs"
                    value={step.fromName}
                    onChange={(e) => setStep(i, "fromName", e.target.value)}
                  />
                  <Input
                    placeholder="From email (optional)"
                    className="h-8 text-xs"
                    value={step.fromEmail}
                    onChange={(e) => setStep(i, "fromEmail", e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Autoresponder"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : automations.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Zap className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No autoresponders yet.</p>
          <p className="text-xs text-muted-foreground mb-4">
            Create a sequence of emails that fire automatically when an event is triggered — subscriber confirmed, purchase made, trial started, etc.
          </p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Autoresponder</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {automations.map((a) => {
            const st = stats[a.id];
            const enr = enrollments[a.id];
            const isExpanded = expandedId === a.id;
            return (
              <div key={a.id} className="rounded-lg border border-border bg-card overflow-hidden">
                {/* Header */}
                <div className="p-5 flex items-center justify-between gap-4">
                  <button
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    onClick={() => expand(a)}
                  >
                    {isExpanded
                      ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    }
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{a.name}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                        <Zap className="h-3 w-3 shrink-0" />
                        <code>{a.triggerEvent}</code>
                      </p>
                    </div>
                  </button>

                  <div className="flex items-center gap-5 text-sm shrink-0">
                    <div className="text-center hidden sm:block">
                      <div className="font-semibold tabular-nums">{a.steps.length}</div>
                      <div className="text-xs text-muted-foreground">steps</div>
                    </div>
                    <div className="text-center hidden sm:block">
                      <div className="font-semibold tabular-nums">{a._count?.enrollments ?? 0}</div>
                      <div className="text-xs text-muted-foreground">enrolled</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 h-7 text-xs"
                      onClick={() => { setTriggerTarget(a); setTriggerEmail(""); }}
                    >
                      <Users className="h-3 w-3" /> Enroll
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 h-7 text-xs"
                      onClick={() => toggleStatus(a)}
                    >
                      {a.status === "active"
                        ? <><Pause className="h-3 w-3" /> Pause</>
                        : <><Play className="h-3 w-3" /> Resume</>}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => del(a)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Expanded panel */}
                {isExpanded && (
                  <div className="border-t border-border bg-muted/20 p-5 space-y-5">
                    {enrollLoading === a.id ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : (
                      <>
                        {/* Stats */}
                        {st && (
                          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                            {[
                              { label: "Total", val: st.enrollments.total },
                              { label: "Active", val: st.enrollments.active },
                              { label: "Completed", val: st.enrollments.completed },
                              { label: "Unsubscribed", val: st.enrollments.unsubscribed },
                              { label: "Completion rate", val: `${st.completion_rate}%` },
                            ].map(({ label, val }) => (
                              <div key={label} className="rounded-md border border-border bg-card px-3 py-2 text-center">
                                <div className="text-sm font-semibold tabular-nums">{val}</div>
                                <div className="text-xs text-muted-foreground">{label}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Steps timeline */}
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Email steps</p>
                          <div className="space-y-2">
                            {a.steps.map((step, i) => (
                              <div key={step.id} className="flex items-start gap-3">
                                <div className="h-6 w-6 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                                  {i + 1}
                                </div>
                                <div className="flex-1 rounded-md border border-border bg-card p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-medium">{step.subject}</p>
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                                      <Clock className="h-3 w-3" />
                                      {delayLabel(step.delayHours, i)}
                                    </span>
                                  </div>
                                  {(step.fromName || step.fromEmail) && (
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {step.fromName && step.fromEmail
                                        ? `${step.fromName} <${step.fromEmail}>`
                                        : step.fromEmail ?? step.fromName}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Enrollments */}
                        {enr && enr.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Recent enrollments</p>
                            <div className="rounded-md border border-border bg-card overflow-hidden">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                                    <th className="px-4 py-2 font-medium">Email</th>
                                    <th className="px-4 py-2 font-medium">Status</th>
                                    <th className="px-4 py-2 font-medium">Step</th>
                                    <th className="px-4 py-2 font-medium">Next send</th>
                                    <th className="px-4 py-2 font-medium w-10"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {enr.map((e) => (
                                    <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                                      <td className="px-4 py-2 font-mono text-xs">{e.email}</td>
                                      <td className="px-4 py-2"><StatusBadge status={e.status} /></td>
                                      <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">{e.currentStep + 1} / {a.steps.length}</td>
                                      <td className="px-4 py-2 text-xs text-muted-foreground">
                                        {e.completedAt
                                          ? `Completed ${new Date(e.completedAt).toLocaleDateString()}`
                                          : e.nextSendAt
                                            ? new Date(e.nextSendAt).toLocaleString()
                                            : "—"}
                                      </td>
                                      <td className="px-4 py-2">
                                        {e.status === "active" && (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 text-destructive"
                                            title="Unenroll"
                                            onClick={() => unenroll(a.id, e.email)}
                                          >
                                            <X className="h-3 w-3" />
                                          </Button>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {enr && enr.length === 0 && (
                          <p className="text-xs text-muted-foreground">No enrollments yet. Contacts are enrolled automatically when the trigger event fires, or you can enroll someone manually.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* API reference */}
      <div className="rounded-lg border border-border bg-card p-5 max-w-2xl">
        <h2 className="text-sm font-semibold mb-3">Trigger via API</h2>
        <pre className="text-xs font-mono bg-background rounded-md p-3 overflow-x-auto text-muted-foreground whitespace-pre">{`POST https://api.continuumapi.com/v1/automations/trigger
X-API-Key: ${primaryKey?.keyRaw ?? "<your-api-key>"}

{
  "event": "subscriber.confirmed",
  "email": "user@example.com",
  "data": { "first_name": "Alice" }  // optional — merged into {{variables}}
}`}</pre>
        <p className="text-xs text-muted-foreground mt-2">Call this from your app whenever the event occurs. All active autoresponders listening to that event will enroll the address automatically.</p>
      </div>
    </div>
  );
}
