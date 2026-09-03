import { createFileRoute } from "@tanstack/react-router";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, GitBranch, Play, Pause, Users, X, ChevronDown, ChevronRight, Clock, Trash2, Copy, Settings2, FlaskConical, BarChart2, Edit2, Sparkles, Phone, Linkedin, CheckSquare, Mail } from "lucide-react";

export const Route = createFileRoute("/dashboard/sequences")({
  head: () => ({ meta: [{ title: "Sequences — Continuum API" }] }),
  component: SequencesPage,
});

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_SHORT: Record<string, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

interface FunnelStep {
  step_id: string;
  step_order: number;
  subject: string;
  delay_days: number;
  sent: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
  bounces: number;
  open_rate: number;
  click_rate: number;
  unsubscribe_rate: number;
  bounce_rate: number;
}

interface SequenceStep {
  id: string;
  stepOrder: number;
  delayDays: number;
  delayHours: number;
  type: StepType;
  subject: string;
  htmlBody: string;
  taskNote?: string;
  condition: string;
}

interface StepVariant {
  id: string;
  stepId: string;
  variantLabel: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  weight: number;
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
  sendDays?: string[];
  sendStartHour?: number;
  sendEndHour?: number;
  timezone?: string;
  _count?: { steps: number; enrollments: number };
}

const CONDITION_LABELS: Record<string, string> = {
  always: "Always send",
  if_not_opened: "Only if not opened",
  if_opened: "Only if opened",
  if_not_clicked: "Only if not clicked",
  if_not_replied: "Only if not replied",
};

type StepType = "email" | "call" | "linkedin" | "task";

const STEP_TYPE_CONFIG: Record<StepType, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  email:    { label: "Email",    icon: Mail,        color: "text-blue-500",   bg: "bg-blue-500/10" },
  call:     { label: "Call",     icon: Phone,       color: "text-emerald-500", bg: "bg-emerald-500/10" },
  linkedin: { label: "LinkedIn", icon: Linkedin,    color: "text-sky-500",    bg: "bg-sky-500/10" },
  task:     { label: "Task",     icon: CheckSquare, color: "text-amber-500",  bg: "bg-amber-500/10" },
};

const DEFAULT_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

function formatWindow(seq: Sequence) {
  const days = seq.sendDays ?? DEFAULT_DAYS;
  const start = seq.sendStartHour ?? 8;
  const end = seq.sendEndHour ?? 17;
  const fmt = (h: number) => `${h === 0 ? 12 : h > 12 ? h - 12 : h}${h < 12 ? "am" : "pm"}`;
  const dayStr = days.length === 7 ? "Every day"
    : days.length === 5 && !days.includes("saturday") && !days.includes("sunday") ? "Mon–Fri"
    : days.map((d) => DAY_SHORT[d]).join(", ");
  return `${dayStr}, ${fmt(start)} – ${fmt(end)} UTC`;
}

function SequencesPage() {
  const { primaryKey } = useAuth();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "", fromName: "", fromEmail: "",
    sendDays: DEFAULT_DAYS as string[],
    sendStartHour: "8", sendEndHour: "17",
  });
  const [saving, setSaving] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<Sequence | null>(null);
  const [enrollEmails, setEnrollEmails] = useState("");
  const [enrolling, setEnrolling] = useState(false);

  // Step management
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, SequenceStep[]>>({});
  const [stepsLoading, setStepsLoading] = useState<string | null>(null);
  const [addingStep, setAddingStep] = useState<string | null>(null);
  const [stepForm, setStepForm] = useState<{ type: StepType; delayDays: string; delayHours: string; subject: string; htmlBody: string; taskNote: string; condition: string; bodyMode: "html" | "text" | "both"; text_body: string }>({ type: "email", delayDays: "1", delayHours: "0", subject: "", htmlBody: "", taskNote: "", condition: "always", bodyMode: "html", text_body: "" });
  const [seqStats, setSeqStats] = useState<Record<string, { sent: number; openRate: number; clickRate: number; replyRate: number; totalEnrolled: number }>>({});
  const [stepSaving, setStepSaving] = useState(false);
  const [stepAiGenerating, setStepAiGenerating] = useState(false);

  // AI brief modal for generating a full sequence
  const [showAIBrief, setShowAIBrief] = useState<string | null>(null); // seqId
  const [aiBriefForm, setAiBriefForm] = useState({ icpDescription: "", goal: "", tone: "professional" as string, numSteps: "5", allowedTypes: ["email", "call", "linkedin"] as string[] });
  const [aiBriefGenerating, setAiBriefGenerating] = useState(false);

  // Variants
  const [stepVariants, setStepVariants] = useState<Record<string, StepVariant[]>>({});
  const [variantsLoading, setVariantsLoading] = useState<Set<string>>(new Set());
  const [addingVariantFor, setAddingVariantFor] = useState<string | null>(null); // stepId
  const [variantForm, setVariantForm] = useState({ variantLabel: "B", subject: "", htmlBody: "", weight: "50" });
  const [variantSaving, setVariantSaving] = useState(false);

  // Send window editing
  const [editWindowFor, setEditWindowFor] = useState<string | null>(null); // seqId
  const [windowForm, setWindowForm] = useState({ sendDays: DEFAULT_DAYS as string[], sendStartHour: "8", sendEndHour: "17" });
  const [windowSaving, setWindowSaving] = useState(false);

  // Step editing
  const [editingStep, setEditingStep] = useState<{ seqId: string; stepId: string } | null>(null);
  const [editStepForm, setEditStepForm] = useState({ type: "email" as StepType, delayDays: "1", delayHours: "0", subject: "", htmlBody: "", taskNote: "", condition: "always" });
  const [editStepSaving, setEditStepSaving] = useState(false);

  // Funnel analytics
  const [showFunnelFor, setShowFunnelFor] = useState<string | null>(null);
  const [funnelData, setFunnelData] = useState<Record<string, FunnelStep[]>>({});
  const [funnelLoading, setFunnelLoading] = useState<string | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: Sequence[] }>("/v1/sequences", primaryKey.keyRaw)
      .then((r) => setSequences(r.data ?? []))
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

  const loadVariants = async (seqId: string, stepId: string) => {
    if (!primaryKey?.keyRaw) return;
    setVariantsLoading((s) => new Set([...s, stepId]));
    try {
      const r = await api.withKey.get<{ data: StepVariant[] }>(
        `/v1/sequences/${seqId}/steps/${stepId}/variants`,
        primaryKey.keyRaw,
      );
      setStepVariants((prev) => ({ ...prev, [stepId]: r.data ?? [] }));
    } catch {
      setStepVariants((prev) => ({ ...prev, [stepId]: [] }));
    } finally {
      setVariantsLoading((s) => { const n = new Set(s); n.delete(stepId); return n; });
    }
  };

  const toggleExpand = (seqId: string) => {
    if (expandedId === seqId) {
      setExpandedId(null);
      setAddingStep(null);
      setEditWindowFor(null);
    } else {
      setExpandedId(seqId);
      setAddingStep(null);
      setEditWindowFor(null);
      if (!steps[seqId]) loadSteps(seqId);
      loadSeqStats(seqId);
    }
  };

  const toggleDay = (day: string, days: string[], setDays: (d: string[]) => void) => {
    setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
  };

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    if (form.sendDays.length === 0) { toast.error("Select at least one send day"); return; }
    setSaving(true);
    try {
      await api.withKey.post("/v1/sequences", {
        name: form.name,
        from_name: form.fromName,
        from_email: form.fromEmail,
        stop_on_reply: true,
        track_opens: true,
        track_clicks: true,
        send_days: form.sendDays,
        send_start_hour: parseInt(form.sendStartHour) || 8,
        send_end_hour: parseInt(form.sendEndHour) || 17,
      }, primaryKey.keyRaw);
      toast.success("Sequence created");
      setCreating(false);
      setForm({ name: "", fromName: "", fromEmail: "", sendDays: DEFAULT_DAYS, sendStartHour: "8", sendEndHour: "17" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (seq: Sequence) => {
    if (!primaryKey?.keyRaw) return;
    const newStatus = seq.status === "active" ? "paused" : "active";
    setSequences((s) => s.map((x) => x.id === seq.id ? { ...x, status: newStatus } : x));
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
      }
    } catch (e: unknown) {
      setSequences((s) => s.map((x) => x.id === seq.id ? { ...x, status: seq.status } : x));
      toast.error((e as Error).message);
    }
  };

  const saveWindow = async (seqId: string) => {
    if (!primaryKey?.keyRaw) return;
    if (windowForm.sendDays.length === 0) { toast.error("Select at least one day"); return; }
    setWindowSaving(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${seqId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({
          send_days: windowForm.sendDays,
          send_start_hour: parseInt(windowForm.sendStartHour) || 8,
          send_end_hour: parseInt(windowForm.sendEndHour) || 17,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
      }
      setSequences((s) => s.map((x) => x.id === seqId ? {
        ...x,
        sendDays: windowForm.sendDays,
        sendStartHour: parseInt(windowForm.sendStartHour) || 8,
        sendEndHour: parseInt(windowForm.sendEndHour) || 17,
      } : x));
      setEditWindowFor(null);
      toast.success("Send window updated");
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setWindowSaving(false); }
  };

  const enroll = async () => {
    if (!primaryKey?.keyRaw || !enrollTarget) return;
    const emails = enrollEmails
      .split(/[\n,;]+/)
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    if (emails.length === 0) { toast.error("Enter at least one valid email address"); return; }
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
    if (stepForm.type === "email") {
      if (!stepForm.subject.trim()) { toast.error("Subject is required for email steps"); return; }
      if (!stepForm.htmlBody.trim() && stepForm.bodyMode !== "text") { toast.error("Email body is required"); return; }
      if (stepForm.bodyMode === "text" && !stepForm.text_body.trim()) { toast.error("Email body is required"); return; }
    } else {
      if (!stepForm.taskNote.trim()) { toast.error(`Instructions are required for ${stepForm.type} steps`); return; }
    }
    setStepSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type: stepForm.type,
        delay_days: parseInt(stepForm.delayDays) || 0,
        delay_hours: parseInt(stepForm.delayHours) || 0,
        condition: stepForm.condition,
      };
      if (stepForm.type === "email") {
        payload.subject = stepForm.subject;
        payload.html_body = stepForm.bodyMode === "text"
          ? `<pre style="font-family:inherit;white-space:pre-wrap">${stepForm.text_body ?? ""}</pre>`
          : stepForm.htmlBody;
        payload.text_body = stepForm.text_body || undefined;
      } else {
        payload.task_note = stepForm.taskNote;
      }
      await api.withKey.post(`/v1/sequences/${seqId}/steps`, payload, primaryKey.keyRaw);
      toast.success("Step added");
      setAddingStep(null);
      setStepForm({ type: "email", delayDays: "1", delayHours: "0", subject: "", htmlBody: "", taskNote: "", condition: "always", bodyMode: "html", text_body: "" });
      await loadSteps(seqId);
      setSequences((s) => s.map((x) => x.id === seqId ? { ...x, _count: { ...x._count, steps: (x._count?.steps ?? 0) + 1, enrollments: x._count?.enrollments ?? 0 } } : x));
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setStepSaving(false);
    }
  };

  const generateStepWithAI = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!stepForm.subject.trim()) { toast.error("Enter a subject or topic hint first"); return; }
    setStepAiGenerating(true);
    try {
      const result = await api.withKey.post<{ variants: Array<{ subject: string; body?: string }> }>(
        "/v1/ai/generate-email",
        { type: "cold_outreach", about: stepForm.subject, tone: "professional", num_variants: 1 },
        primaryKey.keyRaw,
      );
      const variant = result.variants?.[0];
      if (variant) {
        setStepForm((f) => ({ ...f, subject: variant.subject ?? f.subject, htmlBody: variant.body ?? f.htmlBody }));
        toast.success("AI generated email content — review and edit before saving");
      }
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.includes("Growth") || msg.includes("Scale")) {
        toast.error("AI features require a Growth or Scale plan");
      } else {
        toast.error("AI generation failed — try again");
      }
    } finally {
      setStepAiGenerating(false);
    }
  };

  const generateSequenceWithAI = async (seqId: string) => {
    if (!primaryKey?.keyRaw) return;
    if (!aiBriefForm.icpDescription.trim()) { toast.error("Describe your target audience"); return; }
    if (!aiBriefForm.goal.trim()) { toast.error("Describe your goal"); return; }
    setAiBriefGenerating(true);
    try {
      const result = await api.withKey.post<{
        sequence_name: string;
        steps: Array<{ step_order: number; type: StepType; delay_days: number; delay_hours?: number; subject?: string; html_body?: string; task_note?: string; condition?: string }>;
      }>(
        "/v1/ai/generate-sequence",
        {
          icp_description: aiBriefForm.icpDescription,
          goal: aiBriefForm.goal,
          tone: aiBriefForm.tone,
          num_steps: parseInt(aiBriefForm.numSteps) || 5,
          allowed_step_types: aiBriefForm.allowedTypes,
        },
        primaryKey.keyRaw,
      );

      if (!result.steps?.length) { toast.error("AI returned no steps — try again"); return; }

      for (const step of result.steps) {
        const payload: Record<string, unknown> = {
          type: step.type,
          delay_days: step.delay_days ?? 0,
          delay_hours: step.delay_hours ?? 0,
          condition: step.condition ?? "always",
        };
        if (step.type === "email") {
          payload.subject = step.subject ?? "";
          payload.html_body = step.html_body ?? "";
        } else {
          payload.task_note = step.task_note ?? "";
        }
        await api.withKey.post(`/v1/sequences/${seqId}/steps`, payload, primaryKey.keyRaw);
      }

      toast.success(`${result.steps.length} steps added — review and adjust timing`);
      setShowAIBrief(null);
      await loadSteps(seqId);
      setSequences((s) => s.map((x) => x.id === seqId ? { ...x, _count: { ...x._count, steps: (x._count?.steps ?? 0) + result.steps.length, enrollments: x._count?.enrollments ?? 0 } } : x));
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.includes("Growth") || msg.includes("Scale")) {
        toast.error("AI features require a Growth or Scale plan");
      } else {
        toast.error("AI generation failed — try again");
      }
    } finally {
      setAiBriefGenerating(false);
    }
  };

  const openEditStep = (seqId: string, step: SequenceStep) => {
    setEditingStep({ seqId, stepId: step.id });
    setEditStepForm({ type: step.type ?? "email", delayDays: String(step.delayDays), delayHours: String(step.delayHours ?? 0), subject: step.subject ?? "", htmlBody: step.htmlBody ?? "", taskNote: step.taskNote ?? "", condition: step.condition ?? "always" });
  };

  const saveEditStep = async () => {
    if (!primaryKey?.keyRaw || !editingStep) return;
    setEditStepSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type: editStepForm.type,
        delay_days: parseInt(editStepForm.delayDays) || 0,
        delay_hours: parseInt(editStepForm.delayHours) || 0,
        condition: editStepForm.condition,
      };
      if (editStepForm.type === "email") {
        payload.subject = editStepForm.subject;
        payload.html_body = editStepForm.htmlBody;
      } else {
        payload.task_note = editStepForm.taskNote;
      }
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${editingStep.seqId}/steps/${editingStep.stepId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed");
      const updated = await res.json() as SequenceStep;
      setSteps((prev) => ({ ...prev, [editingStep.seqId]: (prev[editingStep.seqId] ?? []).map((s) => s.id === editingStep.stepId ? { ...s, ...updated } : s) }));
      setEditingStep(null);
      toast.success("Step updated");
    } catch { toast.error("Could not update step"); }
    finally { setEditStepSaving(false); }
  };

  const deleteStep = async (seqId: string, stepId: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${seqId}/steps/${stepId}`, {
        method: "DELETE",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
      }
      setSteps((prev) => ({ ...prev, [seqId]: (prev[seqId] ?? []).filter((s) => s.id !== stepId) }));
      setSequences((s) => s.map((x) => x.id === seqId ? { ...x, _count: { ...x._count, steps: Math.max(0, (x._count?.steps ?? 1) - 1), enrollments: x._count?.enrollments ?? 0 } } : x));
      toast.success("Step removed");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const duplicate = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/sequences/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
      }
      toast.success("Sequence duplicated");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const openAddVariant = async (seqId: string, stepId: string) => {
    if (!stepVariants[stepId]) await loadVariants(seqId, stepId);
    setAddingVariantFor(stepId);
    setVariantForm({ variantLabel: "B", subject: "", htmlBody: "", weight: "50" });
  };

  const saveVariant = async (seqId: string, stepId: string) => {
    if (!primaryKey?.keyRaw) return;
    if (!variantForm.subject || !variantForm.htmlBody) { toast.error("Subject and body required"); return; }
    setVariantSaving(true);
    try {
      await api.withKey.post(`/v1/sequences/${seqId}/steps/${stepId}/variants`, {
        variant_label: variantForm.variantLabel,
        subject: variantForm.subject,
        html_body: variantForm.htmlBody,
        weight: parseInt(variantForm.weight) || 50,
      }, primaryKey.keyRaw);
      toast.success("Variant added");
      setAddingVariantFor(null);
      await loadVariants(seqId, stepId);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setVariantSaving(false); }
  };

  const deleteVariant = async (seqId: string, stepId: string, variantId: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      const res = await fetch(
        `https://api.continuumapi.com/v1/sequences/${seqId}/steps/${stepId}/variants/${variantId}`,
        { method: "DELETE", headers: { "X-API-Key": primaryKey.keyRaw! } },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Failed (${res.status})`);
      }
      setStepVariants((prev) => ({ ...prev, [stepId]: (prev[stepId] ?? []).filter((v) => v.id !== variantId) }));
      toast.success("Variant removed");
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const loadFunnel = async (seqId: string) => {
    if (!primaryKey?.keyRaw || funnelData[seqId] !== undefined) return;
    setFunnelLoading(seqId);
    try {
      const r = await api.withKey.get<{ steps: FunnelStep[] }>(`/v1/analytics/sequences/${seqId}/funnel`, primaryKey.keyRaw);
      setFunnelData((prev) => ({ ...prev, [seqId]: r.steps ?? [] }));
    } catch {
      setFunnelData((prev) => ({ ...prev, [seqId]: [] }));
    } finally {
      setFunnelLoading(null);
    }
  };

  const toggleFunnel = (seqId: string) => {
    if (showFunnelFor === seqId) {
      setShowFunnelFor(null);
    } else {
      setShowFunnelFor(seqId);
      loadFunnel(seqId);
    }
  };

  const loadSeqStats = async (seqId: string) => {
    if (seqStats[seqId]) return; // already loaded
    try {
      const data = await api.withKey.get<{ sent: number; openRate: number; clickRate: number; replyRate: number; totalEnrolled: number }>(`/v1/sequences/${seqId}/stats`, primaryKey?.keyRaw ?? "");
      setSeqStats(prev => ({ ...prev, [seqId]: data }));
    } catch { /* non-fatal */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">Multi-channel outreach — email, calls, LinkedIn, tasks — with AI-generated steps.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Sequence
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-lg">
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

          {/* Send window */}
          <div className="space-y-2 pt-1 border-t border-border">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Send Window</Label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, sendDays: f.sendDays.includes(day) ? f.sendDays.filter((d) => d !== day) : [...f.sendDays, day] }))}
                  className={`h-7 px-2.5 rounded-md text-xs font-medium border transition-colors ${
                    form.sendDays.includes(day)
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-muted-foreground border-border hover:border-foreground/30"
                  }`}
                >
                  {DAY_SHORT[day]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Label className="text-xs whitespace-nowrap">Send hours</Label>
              <Input
                type="number" min="0" max="23" className="h-7 w-14 text-xs text-center"
                value={form.sendStartHour}
                onChange={(e) => setForm((f) => ({ ...f, sendStartHour: e.target.value }))}
              />
              <span className="text-muted-foreground text-xs">to</span>
              <Input
                type="number" min="0" max="23" className="h-7 w-14 text-xs text-center"
                value={form.sendEndHour}
                onChange={(e) => setForm((f) => ({ ...f, sendEndHour: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">UTC</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create Sequence"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {/* AI Brief modal — generate full sequence */}
      {showAIBrief && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-lg space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                <h2 className="text-sm font-semibold">Generate Sequence with AI</h2>
              </div>
              <button onClick={() => setShowAIBrief(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-xs text-muted-foreground">Describe your target audience and goal — AI will plan the full multi-channel sequence with email copy, call scripts, and LinkedIn touchpoints.</p>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Who are you targeting? (ICP)</Label>
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="e.g. VP of Sales at B2B SaaS companies with 50-500 employees, using Salesforce, recently raised Series A"
                  value={aiBriefForm.icpDescription}
                  onChange={(e) => setAiBriefForm((f) => ({ ...f, icpDescription: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">What's the goal of this sequence?</Label>
                <Input
                  placeholder="e.g. Book a 15-min demo for our AI-powered cold email tool"
                  value={aiBriefForm.goal}
                  onChange={(e) => setAiBriefForm((f) => ({ ...f, goal: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Tone</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none"
                    value={aiBriefForm.tone}
                    onChange={(e) => setAiBriefForm((f) => ({ ...f, tone: e.target.value }))}
                  >
                    {["professional", "casual", "friendly", "direct"].map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Number of steps</Label>
                  <Input
                    type="number" min="2" max="10"
                    value={aiBriefForm.numSteps}
                    onChange={(e) => setAiBriefForm((f) => ({ ...f, numSteps: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Channels to include</Label>
                <div className="flex flex-wrap gap-2">
                  {(["email", "call", "linkedin", "task"] as StepType[]).map((t) => {
                    const cfg = STEP_TYPE_CONFIG[t];
                    const Icon = cfg.icon;
                    const active = aiBriefForm.allowedTypes.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAiBriefForm((f) => ({ ...f, allowedTypes: active ? f.allowedTypes.filter((x) => x !== t) : [...f.allowedTypes, t] }))}
                        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border transition-colors ${active ? `${cfg.bg} ${cfg.color} border-current/30` : "text-muted-foreground border-border hover:border-foreground/30"}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button className="gap-1.5" onClick={() => generateSequenceWithAI(showAIBrief!)} disabled={aiBriefGenerating}>
                <Sparkles className="h-3.5 w-3.5" />
                {aiBriefGenerating ? "Generating…" : "Generate Sequence"}
              </Button>
              <Button variant="outline" onClick={() => setShowAIBrief(null)}>Cancel</Button>
            </div>
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
                placeholder={"alice@company.com\nbob@company.com"}
                value={enrollEmails}
                onChange={(e) => setEnrollEmails(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">One per line or comma-separated. Duplicates are skipped.</p>
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
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-4 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <div className="flex gap-4">
                  <Skeleton className="h-8 w-12" />
                  <Skeleton className="h-8 w-12" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : sequences.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No sequences yet. Create a multi-step cold outreach campaign.</p>
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
                    {seqStats[seq.id] && (
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span><span className="font-medium text-foreground">{seqStats[seq.id].totalEnrolled}</span> enrolled</span>
                        <span><span className="font-medium text-foreground">{seqStats[seq.id].sent}</span> sent</span>
                        <span><span className="font-medium text-blue-500">{seqStats[seq.id].openRate}%</span> open</span>
                        <span><span className="font-medium text-violet-500">{seqStats[seq.id].clickRate}%</span> click</span>
                        <span><span className="font-medium text-emerald-500">{seqStats[seq.id].replyRate}%</span> reply</span>
                      </div>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-4 text-sm shrink-0">
                  <div className="text-center hidden sm:block">
                    <div className="font-semibold tabular-nums">{seq._count?.steps ?? 0}</div>
                    <div className="text-xs text-muted-foreground">steps</div>
                  </div>
                  <div className="text-center hidden sm:block">
                    <div className="font-semibold tabular-nums">{seq._count?.enrollments ?? 0}</div>
                    <div className="text-xs text-muted-foreground">enrolled</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => toggleStatus(seq)}>
                    {seq.status === "active" ? <><Pause className="h-3 w-3" /> Pause</> : <><Play className="h-3 w-3" /> Resume</>}
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => { setEnrollTarget(seq); setEnrollEmails(""); }}>
                    <Users className="h-3 w-3" /> Enroll
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-1 h-7 text-xs" onClick={() => duplicate(seq.id)}>
                    <Copy className="h-3 w-3" /> Dupe
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1 h-7 text-xs ${showFunnelFor === seq.id ? "bg-muted" : ""}`}
                    onClick={() => toggleFunnel(seq.id)}
                  >
                    <BarChart2 className="h-3 w-3" /> Funnel
                  </Button>
                </div>
              </div>

              {/* Funnel analytics panel */}
              {showFunnelFor === seq.id && (
                <div className="border-t border-border bg-muted/10 p-5 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step Funnel</p>
                  {funnelLoading === seq.id ? (
                    <p className="text-xs text-muted-foreground">Loading funnel…</p>
                  ) : (funnelData[seq.id] ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No data yet — enroll contacts and send some emails to see step-level metrics.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid gap-x-4 items-center text-xs text-muted-foreground px-1" style={{ gridTemplateColumns: "1.5rem 1fr 3rem 4rem 4rem 4rem" }}>
                        <span>#</span>
                        <span>Step</span>
                        <span className="text-right">Sent</span>
                        <span className="text-right">Opens</span>
                        <span className="text-right">Clicks</span>
                        <span className="text-right">Bounces</span>
                      </div>
                      {(funnelData[seq.id] ?? []).map((step) => (
                        <div key={step.step_id} className="rounded-md border border-border bg-card p-3 space-y-2">
                          <div className="grid gap-x-4 items-center" style={{ gridTemplateColumns: "1.5rem 1fr 3rem 4rem 4rem 4rem" }}>
                            <span className="h-5 w-5 rounded-full bg-muted border border-border flex items-center justify-center text-xs font-semibold shrink-0">{step.step_order}</span>
                            <p className="text-sm truncate">{step.subject}</p>
                            <span className="text-sm font-mono tabular-nums text-right">{step.sent}</span>
                            <span className="text-sm font-mono tabular-nums text-right">{(step.open_rate * 100).toFixed(1)}%</span>
                            <span className="text-sm font-mono tabular-nums text-right">{(step.click_rate * 100).toFixed(1)}%</span>
                            <span className={`text-sm font-mono tabular-nums text-right ${step.bounce_rate > 0.05 ? "text-[oklch(0.58_0.22_27)]" : ""}`}>{(step.bounce_rate * 100).toFixed(1)}%</span>
                          </div>
                          {step.sent > 0 && (
                            <div className="space-y-1 pt-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground w-10 shrink-0">Opens</span>
                                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full bg-foreground/70 transition-all" style={{ width: `${Math.min(100, step.open_rate * 100)}%` }} />
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground w-10 shrink-0">Clicks</span>
                                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div className="h-full rounded-full bg-foreground/40 transition-all" style={{ width: `${Math.min(100, step.click_rate * 100)}%` }} />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Steps + settings panel */}
              {expandedId === seq.id && (
                <div className="border-t border-border bg-muted/20 p-5 space-y-5">
                  {stepsLoading === seq.id ? (
                    <p className="text-xs text-muted-foreground">Loading steps…</p>
                  ) : (
                    <>
                      {/* Send window row */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-3.5 w-3.5 shrink-0" />
                          <span>{formatWindow(seq)}</span>
                        </div>
                        {editWindowFor === seq.id ? null : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 h-7 text-xs"
                            onClick={() => {
                              setWindowForm({
                                sendDays: seq.sendDays ?? DEFAULT_DAYS,
                                sendStartHour: String(seq.sendStartHour ?? 8),
                                sendEndHour: String(seq.sendEndHour ?? 17),
                              });
                              setEditWindowFor(seq.id);
                            }}
                          >
                            <Settings2 className="h-3 w-3" /> Edit window
                          </Button>
                        )}
                      </div>

                      {/* Send window edit form */}
                      {editWindowFor === seq.id && (
                        <div className="rounded-md border border-border bg-card p-4 space-y-3">
                          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Send Window</p>
                          <div className="flex flex-wrap gap-1.5">
                            {DAYS.map((day) => (
                              <button
                                key={day}
                                type="button"
                                onClick={() => toggleDay(day, windowForm.sendDays, (d) => setWindowForm((f) => ({ ...f, sendDays: d })))}
                                className={`h-7 px-2.5 rounded-md text-xs font-medium border transition-colors ${
                                  windowForm.sendDays.includes(day)
                                    ? "bg-foreground text-background border-foreground"
                                    : "bg-background text-muted-foreground border-border hover:border-foreground/30"
                                }`}
                              >
                                {DAY_SHORT[day]}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center gap-2">
                            <Label className="text-xs whitespace-nowrap">Hours</Label>
                            <Input
                              type="number" min="0" max="23" className="h-7 w-14 text-xs text-center"
                              value={windowForm.sendStartHour}
                              onChange={(e) => setWindowForm((f) => ({ ...f, sendStartHour: e.target.value }))}
                            />
                            <span className="text-xs text-muted-foreground">to</span>
                            <Input
                              type="number" min="0" max="23" className="h-7 w-14 text-xs text-center"
                              value={windowForm.sendEndHour}
                              onChange={(e) => setWindowForm((f) => ({ ...f, sendEndHour: e.target.value }))}
                            />
                            <span className="text-xs text-muted-foreground">UTC</span>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveWindow(seq.id)} disabled={windowSaving}>{windowSaving ? "Saving…" : "Save"}</Button>
                            <Button size="sm" variant="outline" onClick={() => setEditWindowFor(null)}>Cancel</Button>
                          </div>
                        </div>
                      )}

                      {/* Steps list */}
                      {(steps[seq.id] ?? []).length === 0 && addingStep !== seq.id && showAIBrief !== seq.id && (
                        <div className="rounded-md border border-dashed border-border p-4 text-center space-y-2">
                          <p className="text-xs text-muted-foreground">No steps yet.</p>
                          <div className="flex items-center justify-center gap-2">
                            <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => { setAddingStep(seq.id); setStepForm({ type: "email", delayDays: "0", delayHours: "0", subject: "", htmlBody: "", taskNote: "", condition: "always", bodyMode: "html", text_body: "" }); }}>
                              <Plus className="h-3.5 w-3.5" /> Add manually
                            </Button>
                            <Button size="sm" className="gap-1.5 h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white" onClick={() => { setShowAIBrief(seq.id); setAiBriefForm({ icpDescription: "", goal: "", tone: "professional", numSteps: "5", allowedTypes: ["email", "call", "linkedin"] }); }}>
                              <Sparkles className="h-3.5 w-3.5" /> Create with AI
                            </Button>
                          </div>
                        </div>
                      )}

                      {(steps[seq.id] ?? []).map((step, i) => {
                        const variants = stepVariants[step.id];
                        const isLoadingVariants = variantsLoading.has(step.id);
                        const stepType = (step.type ?? "email") as StepType;
                        const typeCfg = STEP_TYPE_CONFIG[stepType];
                        const TypeIcon = typeCfg.icon;
                        return (
                          <div key={step.id} className="flex items-start gap-3">
                            <div className="h-7 w-7 rounded-full bg-muted border border-border flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
                              {step.stepOrder}
                            </div>
                            <div className="flex-1 min-w-0 rounded-md border border-border bg-card p-3 space-y-2">
                              {/* Step header */}
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-md ${typeCfg.bg} ${typeCfg.color}`}>
                                      <TypeIcon className="h-3 w-3" />
                                      {typeCfg.label}
                                    </span>
                                    <p className="text-sm font-medium truncate">{stepType === "email" ? step.subject : (step.taskNote ?? "")}</p>
                                  </div>
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
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs gap-1 text-muted-foreground"
                                    onClick={() => {
                                      if (addingVariantFor === step.id) {
                                        setAddingVariantFor(null);
                                      } else {
                                        openAddVariant(seq.id, step.id);
                                      }
                                    }}
                                  >
                                    <FlaskConical className="h-3 w-3" />
                                    {variants && variants.length > 0 ? `A/B (${variants.length + 1})` : "A/B"}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground"
                                    onClick={() => editingStep?.stepId === step.id ? setEditingStep(null) : openEditStep(seq.id, step)}
                                    title="Edit step"
                                  >
                                    <Edit2 className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-destructive"
                                    onClick={() => deleteStep(seq.id, step.id)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>

                              {/* Inline step editor */}
                              {editingStep?.stepId === step.id && (
                                <div className="border border-border rounded-md p-3 space-y-2 bg-muted/20 text-xs">
                                  <div>
                                    <label className="text-muted-foreground block mb-1">Step type</label>
                                    <div className="flex gap-1 flex-wrap">
                                      {(["email", "call", "linkedin", "task"] as StepType[]).map((t) => {
                                        const cfg = STEP_TYPE_CONFIG[t];
                                        const Icon = cfg.icon;
                                        return (
                                          <button key={t} type="button" onClick={() => setEditStepForm((f) => ({ ...f, type: t }))}
                                            className={`flex items-center gap-1 h-6 px-2 rounded-md text-xs font-medium border transition-colors ${editStepForm.type === t ? `${cfg.bg} ${cfg.color} border-current/30` : "text-muted-foreground border-border"}`}>
                                            <Icon className="h-3 w-3" />{cfg.label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                  <div className="flex gap-2">
                                    <div className="flex-1">
                                      <label className="text-muted-foreground block mb-1">Delay (days)</label>
                                      <Input className="h-7 text-xs" value={editStepForm.delayDays} onChange={(e) => setEditStepForm((f) => ({ ...f, delayDays: e.target.value }))} type="number" min="0" />
                                    </div>
                                    <div className="flex-1">
                                      <label className="text-muted-foreground block mb-1">Condition</label>
                                      <select className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs" value={editStepForm.condition} onChange={(e) => setEditStepForm((f) => ({ ...f, condition: e.target.value }))}>
                                        {["always","if_not_opened","if_opened","if_not_clicked","if_not_replied"].map((c) => (
                                          <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                                        ))}
                                      </select>
                                    </div>
                                  </div>
                                  {editStepForm.type === "email" ? (
                                    <>
                                      <div>
                                        <label className="text-muted-foreground block mb-1">Subject</label>
                                        <Input className="h-7 text-xs" value={editStepForm.subject} onChange={(e) => setEditStepForm((f) => ({ ...f, subject: e.target.value }))} />
                                      </div>
                                      <div>
                                        <label className="text-muted-foreground block mb-1">HTML body</label>
                                        <textarea className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono h-28 resize-y" value={editStepForm.htmlBody} onChange={(e) => setEditStepForm((f) => ({ ...f, htmlBody: e.target.value }))} />
                                      </div>
                                    </>
                                  ) : (
                                    <div>
                                      <label className="text-muted-foreground block mb-1">Instructions / task note</label>
                                      <textarea className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs h-20 resize-y" placeholder={`What to do for this ${editStepForm.type} step…`} value={editStepForm.taskNote} onChange={(e) => setEditStepForm((f) => ({ ...f, taskNote: e.target.value }))} />
                                    </div>
                                  )}
                                  <div className="flex gap-2 justify-end">
                                    <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setEditingStep(null)}>Cancel</Button>
                                    <Button size="sm" className="h-6 text-xs" onClick={saveEditStep} disabled={editStepSaving}>{editStepSaving ? "Saving…" : "Save"}</Button>
                                  </div>
                                </div>
                              )}

                              {/* Existing variants */}
                              {isLoadingVariants && <p className="text-xs text-muted-foreground">Loading variants…</p>}
                              {variants && variants.length > 0 && (
                                <div className="space-y-1.5 pt-1 border-t border-border">
                                  <p className="text-xs text-muted-foreground font-medium">Variants</p>
                                  <div className="flex flex-wrap gap-2">
                                    <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1">
                                      <span className="text-xs font-mono font-semibold">A</span>
                                      <span className="text-xs text-muted-foreground truncate max-w-[120px]">{step.subject}</span>
                                      <span className="text-xs text-muted-foreground ml-1">{100 - variants.reduce((s, v) => s + v.weight, 0)}%</span>
                                    </div>
                                    {variants.map((v) => (
                                      <div key={v.id} className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1">
                                        <span className="text-xs font-mono font-semibold">{v.variantLabel}</span>
                                        <span className="text-xs text-muted-foreground truncate max-w-[120px]">{v.subject}</span>
                                        <span className="text-xs text-muted-foreground ml-1">{v.weight}%</span>
                                        <button
                                          className="text-muted-foreground hover:text-destructive ml-1"
                                          onClick={() => deleteVariant(seq.id, step.id, v.id)}
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Add variant form */}
                              {addingVariantFor === step.id && (
                                <div className="space-y-2 pt-2 border-t border-border">
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">New Variant</p>
                                  <div className="grid grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                      <Label className="text-xs">Label</Label>
                                      <Input
                                        className="h-7 text-xs font-mono"
                                        placeholder="B"
                                        maxLength={5}
                                        value={variantForm.variantLabel}
                                        onChange={(e) => setVariantForm((f) => ({ ...f, variantLabel: e.target.value }))}
                                      />
                                    </div>
                                    <div className="col-span-2 space-y-1">
                                      <Label className="text-xs">Subject</Label>
                                      <Input
                                        className="h-7 text-xs"
                                        placeholder="Different subject line"
                                        value={variantForm.subject}
                                        onChange={(e) => setVariantForm((f) => ({ ...f, subject: e.target.value }))}
                                      />
                                    </div>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Body (HTML)</Label>
                                    <textarea
                                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono min-h-[60px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                      placeholder="<p>Alternative body copy…</p>"
                                      value={variantForm.htmlBody}
                                      onChange={(e) => setVariantForm((f) => ({ ...f, htmlBody: e.target.value }))}
                                    />
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Label className="text-xs whitespace-nowrap">Send to</Label>
                                    <Input
                                      type="number" min="1" max="99" className="h-7 w-14 text-xs text-center"
                                      value={variantForm.weight}
                                      onChange={(e) => setVariantForm((f) => ({ ...f, weight: e.target.value }))}
                                    />
                                    <span className="text-xs text-muted-foreground">% of recipients</span>
                                  </div>
                                  <div className="flex gap-2">
                                    <Button size="sm" className="h-7 text-xs" onClick={() => saveVariant(seq.id, step.id)} disabled={variantSaving}>
                                      {variantSaving ? "Saving…" : "Add Variant"}
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddingVariantFor(null)}>Cancel</Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {/* Add step */}
                      {addingStep === seq.id ? (
                        <div className="rounded-md border border-border bg-card p-4 space-y-3">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">New Step</p>

                          {/* Step type picker */}
                          <div>
                            <Label className="text-xs mb-1.5 block">Step type</Label>
                            <div className="flex gap-1.5 flex-wrap">
                              {(["email", "call", "linkedin", "task"] as StepType[]).map((t) => {
                                const cfg = STEP_TYPE_CONFIG[t];
                                const Icon = cfg.icon;
                                return (
                                  <button key={t} type="button"
                                    onClick={() => setStepForm((f) => ({ ...f, type: t }))}
                                    className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border transition-colors ${stepForm.type === t ? `${cfg.bg} ${cfg.color} border-current/30` : "text-muted-foreground border-border hover:border-foreground/30"}`}>
                                    <Icon className="h-3.5 w-3.5" />{cfg.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

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
                              <Label className="text-xs">Condition</Label>
                              <select
                                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                value={stepForm.condition}
                                onChange={(e) => setStepForm((f) => ({ ...f, condition: e.target.value }))}
                              >
                                {Object.entries(CONDITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select>
                            </div>
                          </div>

                          {stepForm.type === "email" ? (
                            <>
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <Label className="text-xs">Subject</Label>
                                  <button
                                    type="button"
                                    onClick={generateStepWithAI}
                                    disabled={stepAiGenerating}
                                    className="flex items-center gap-1 text-xs text-violet-500 hover:text-violet-400 disabled:opacity-50 transition-colors"
                                  >
                                    <Sparkles className="h-3 w-3" />
                                    {stepAiGenerating ? "Generating…" : "Generate with AI"}
                                  </button>
                                </div>
                                <Input placeholder="Quick question about {{company}}" value={stepForm.subject} onChange={(e) => setStepForm((f) => ({ ...f, subject: e.target.value }))} className="h-8 text-sm" />
                              </div>
                              {/* Content type toggle */}
                              <div>
                                <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email Format</Label>
                                <div className="flex rounded-md border border-border overflow-hidden w-fit">
                                  {(["html", "text", "both"] as const).map((m) => (
                                    <button
                                      key={m}
                                      type="button"
                                      onClick={() => setStepForm(prev => ({ ...prev, bodyMode: m }))}
                                      className={`px-3 py-1 text-xs font-medium transition-colors capitalize ${
                                        (stepForm.bodyMode ?? "html") === m
                                          ? "bg-foreground text-background"
                                          : "bg-transparent text-muted-foreground hover:text-foreground"
                                      }`}
                                    >
                                      {m === "both" ? "HTML + Text" : m.toUpperCase()}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              {((stepForm.bodyMode ?? "html") === "html" || stepForm.bodyMode === "both") && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Email body (HTML){stepForm.bodyMode === "both" ? " (primary)" : ""}</Label>
                                  <textarea
                                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    placeholder={"<p>Hi {{first_name}},</p>\n<p>I noticed {{company}} is growing fast…</p>"}
                                    value={stepForm.htmlBody}
                                    onChange={(e) => setStepForm((f) => ({ ...f, htmlBody: e.target.value }))}
                                  />
                                </div>
                              )}
                              {((stepForm.bodyMode ?? "html") === "text" || stepForm.bodyMode === "both") && (
                                <div>
                                  <Label className="text-xs font-medium text-muted-foreground mb-1 block">
                                    Plain text body {stepForm.bodyMode === "both" ? "(fallback)" : ""}
                                  </Label>
                                  <textarea
                                    value={stepForm.text_body ?? ""}
                                    onChange={e => setStepForm(prev => ({ ...prev, text_body: e.target.value }))}
                                    rows={8}
                                    placeholder="Plain text version of the email. No HTML tags — use {{firstName}} variables as normal."
                                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono resize-y"
                                  />
                                  {(stepForm.bodyMode ?? "html") === "text" && (
                                    <p className="text-xs text-muted-foreground mt-1">Plain text emails have higher deliverability for cold outreach and cannot include open/click tracking.</p>
                                  )}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="space-y-1">
                              <Label className="text-xs">
                                {stepForm.type === "call" ? "Call script / talking points" :
                                 stepForm.type === "linkedin" ? "LinkedIn message or action" :
                                 "Task instructions"}
                              </Label>
                              <textarea
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                placeholder={
                                  stepForm.type === "call" ? "Call {{first_name}} at {{company}}. Ask about their current email outreach process. Key talking points: …" :
                                  stepForm.type === "linkedin" ? "Connect with {{first_name}} on LinkedIn. Reference the emails sent. Mention the case study link in the connection note." :
                                  "Send follow-up deck to {{email}} using Docusend for tracking. Check for views after 48 hours."
                                }
                                value={stepForm.taskNote}
                                onChange={(e) => setStepForm((f) => ({ ...f, taskNote: e.target.value }))}
                              />
                            </div>
                          )}

                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => addStep(seq.id)} disabled={stepSaving}>{stepSaving ? "Saving…" : "Add Step"}</Button>
                            <Button size="sm" variant="outline" onClick={() => setAddingStep(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (steps[seq.id] ?? []).length > 0 ? (
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 flex-1"
                            onClick={() => { setAddingStep(seq.id); setStepForm({ type: "email", delayDays: "1", delayHours: "0", subject: "", htmlBody: "", taskNote: "", condition: "always", bodyMode: "html", text_body: "" }); }}
                          >
                            <Plus className="h-3.5 w-3.5" /> Add Step
                          </Button>
                          <Button
                            size="sm"
                            className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
                            onClick={() => { setShowAIBrief(seq.id); setAiBriefForm({ icpDescription: "", goal: "", tone: "professional", numSteps: "3", allowedTypes: ["email", "call", "linkedin"] }); }}
                          >
                            <Sparkles className="h-3.5 w-3.5" /> AI Steps
                          </Button>
                        </div>
                      ) : null}
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
