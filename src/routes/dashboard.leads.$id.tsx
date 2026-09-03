import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, Mail, Building2, Briefcase, MapPin, Phone, Linkedin,
  Clock, MousePointerClick, Eye, MessageSquare, Send, Tag, X, Loader2,
  ExternalLink, CheckCircle2, AlertCircle, Circle,
} from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";

export const Route = createFileRoute("/dashboard/leads/$id")({
  head: () => ({ meta: [{ title: "Lead Profile — Continuum" }] }),
  component: LeadProfilePage,
});

interface LeadDetail {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  status: string;
  tags: string[];
  customVars: Record<string, unknown> | null;
  createdAt: string;
  repliedAt: string | null;
}

interface TimelineEvent {
  type: "sent" | "open" | "click" | "replied";
  occurredAt: string;
  data: {
    id?: string;
    subject?: string;
    status?: string;
    linkUrl?: string | null;
    bodySnippet?: string | null;
    sendMessageId?: string;
  };
}

interface Enrollment {
  id: string;
  sequenceId: string;
  status: string;
  currentStep: number;
  nextSendAt: string | null;
  enrolledAt: string;
  completedAt: string | null;
  repliedAt: string | null;
  sequence: { id: string; name: string };
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  sent: <Send className="h-3.5 w-3.5" />,
  open: <Eye className="h-3.5 w-3.5" />,
  click: <MousePointerClick className="h-3.5 w-3.5" />,
  replied: <MessageSquare className="h-3.5 w-3.5" />,
};

const EVENT_COLORS: Record<string, string> = {
  sent: "text-muted-foreground bg-muted/40",
  open: "text-blue-600 bg-blue-500/10 dark:text-blue-400",
  click: "text-violet-600 bg-violet-500/10 dark:text-violet-400",
  replied: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-400",
};

const ENROLLMENT_STATUS_ICON: Record<string, React.ReactNode> = {
  active: <Circle className="h-3 w-3 fill-emerald-500 text-emerald-500" />,
  completed: <CheckCircle2 className="h-3 w-3 text-muted-foreground" />,
  replied: <MessageSquare className="h-3 w-3 text-emerald-600" />,
  bounced: <AlertCircle className="h-3 w-3 text-destructive" />,
  paused: <Clock className="h-3 w-3 text-amber-500" />,
  unsubscribed: <X className="h-3 w-3 text-muted-foreground" />,
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function LeadProfilePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(true);

  // Tags state
  const [tagDraft, setTagDraft] = useState("");
  const [savingTags, setSavingTags] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get<{ lead: LeadDetail; timeline: TimelineEvent[]; enrollments: Enrollment[] }>(
        `/v1/leads/${id}/activity`,
      );
      setLead(data.lead);
      setTimeline(data.timeline);
      setEnrollments(data.enrollments);
    } catch {
      toast.error("Could not load lead.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [id]);

  async function addTag(tag: string) {
    if (!lead || !tag.trim()) return;
    const newTags = [...new Set([...lead.tags, tag.trim()])].slice(0, 20);
    await saveTags(newTags);
    setTagDraft("");
  }

  async function removeTag(tag: string) {
    if (!lead) return;
    await saveTags(lead.tags.filter((t) => t !== tag));
  }

  async function saveTags(tags: string[]) {
    if (!lead) return;
    setSavingTags(true);
    try {
      await api.patch(`/v1/leads/${lead.id}/tags`, { tags });
      setLead((prev) => prev ? { ...prev, tags } : prev);
    } catch { toast.error("Failed to update tags."); }
    finally { setSavingTags(false); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p>Lead not found.</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate({ to: "/dashboard/leads" })}>Back to Leads</Button>
      </div>
    );
  }

  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
  const customVarEntries = lead.customVars ? Object.entries(lead.customVars).filter(([, v]) => v !== null && v !== undefined && v !== "") : [];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back */}
      <button
        onClick={() => navigate({ to: "/dashboard/leads" })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Leads
      </button>

      {/* Hero card */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {/* Avatar */}
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-lg font-semibold shrink-0 text-foreground/60">
              {(lead.firstName?.[0] ?? lead.email[0]).toUpperCase()}
            </div>
            <div>
              <h1 className="text-xl font-semibold">{name}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                {lead.title && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Briefcase className="h-3.5 w-3.5" />{lead.title}
                  </span>
                )}
                {lead.company && (
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Building2 className="h-3.5 w-3.5" />{lead.company}
                  </span>
                )}
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" />{lead.email}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={lead.status} />
            <span className="text-xs text-muted-foreground">Added {fmtDate(lead.createdAt)}</span>
          </div>
        </div>

        {/* Tags */}
        <div className="mt-5 pt-4 border-t border-border">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {lead.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                {t}
                <button onClick={() => removeTag(t)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => { e.preventDefault(); addTag(tagDraft); }}
            >
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="Add tag…"
                className="h-6 w-28 text-xs px-2 rounded-full"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagDraft); } }}
              />
              {savingTags && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </form>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: activity timeline */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold">Activity</h2>
          {timeline.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No email activity yet.
            </div>
          ) : (
            <div className="relative space-y-1">
              {timeline.map((ev, i) => (
                <div key={i} className="flex gap-3 items-start py-2">
                  <div className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${EVENT_COLORS[ev.type] ?? EVENT_COLORS.sent}`}>
                    {EVENT_ICONS[ev.type] ?? EVENT_ICONS.sent}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium capitalize">{ev.type === "open" ? "Opened" : ev.type === "click" ? "Clicked link" : ev.type === "replied" ? "Replied" : "Email sent"}</p>
                    {ev.data.subject && <p className="text-xs text-muted-foreground truncate">{ev.data.subject}</p>}
                    {ev.data.linkUrl && (
                      <a href={ev.data.linkUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline flex items-center gap-0.5">
                        {ev.data.linkUrl.length > 60 ? ev.data.linkUrl.slice(0, 60) + "…" : ev.data.linkUrl}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                    {ev.data.bodySnippet && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 italic">"{ev.data.bodySnippet}"</p>}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{fmt(ev.occurredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: sequences + enrichment */}
        <div className="space-y-4">
          {/* Sequences */}
          <div>
            <h2 className="text-sm font-semibold mb-3">Sequences</h2>
            {enrollments.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not in any sequence.</p>
            ) : (
              <div className="space-y-2">
                {enrollments.map((enr) => (
                  <div key={enr.id} className="rounded-lg border border-border bg-card/50 p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5">{ENROLLMENT_STATUS_ICON[enr.status] ?? ENROLLMENT_STATUS_ICON.active}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{enr.sequence.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{enr.status} · Step {enr.currentStep + 1}</p>
                        {enr.nextSendAt && enr.status === "active" && (
                          <p className="text-xs text-muted-foreground">Next: {fmt(enr.nextSendAt)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Enrichment / Custom vars */}
          {customVarEntries.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-3">Enrichment</h2>
              <div className="rounded-lg border border-border bg-card/50 p-3 space-y-2">
                {customVarEntries.map(([k, v]) => (
                  <div key={k}>
                    <p className="text-xs text-muted-foreground capitalize">{k.replace(/_/g, " ")}</p>
                    <p className="text-xs text-foreground mt-0.5">{String(v)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
