import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { Plus, Megaphone, Send, FlaskConical, X, Copy, AlertTriangle, Users, Clock, Edit2, XCircle, CheckCircle2, Circle, Monitor, Smartphone, Eye, TrendingUp, BarChart2, ChevronRight, Target, Play, Trophy, Sparkles, Bold, Italic, Underline, List, ListOrdered, Link, AlignLeft, AlignCenter, AlignRight, Code2, Minus } from "lucide-react";

// ── Subject line scorer (client-side, no API) ─────────────────────────────────

const SPAM_TRIGGERS = [
  "free","urgent","act now","click here","limited time","no obligation","guaranteed",
  "winner","congratulations","prize","dear friend","make money","work from home",
  "buy now","order now","earn","$$","100%","risk-free","special promotion",
  "double your","extra income","increase sales","as seen on","cash bonus",
  "you have been selected","this is not spam","buy direct","lowest price",
  "no hidden","incredible deal","once in a lifetime","only for you","be your own boss",
  "lose weight","amazing","incredible","miracle","stop snoring","enlarge",
];

function scoreSubject(s: string): { score: number; hints: Array<{ type: "ok"|"warn"|"bad"; text: string }> } {
  if (!s.trim()) return { score: 0, hints: [] };
  const hints: Array<{ type: "ok"|"warn"|"bad"; text: string }> = [];
  let score = 70;
  const len = s.length;

  // Length
  if (len < 15)       { score -= 25; hints.push({ type: "bad",  text: `Too short (${len} chars — aim for 30–50)` }); }
  else if (len < 28)  { score -= 8;  hints.push({ type: "warn", text: `Short (${len} chars — aim for 30–50)` }); }
  else if (len <= 50) { score += 15; hints.push({ type: "ok",   text: `Good length (${len} chars)` }); }
  else if (len <= 65) { score -= 5;  hints.push({ type: "warn", text: `Slightly long (${len} chars)` }); }
  else                { score -= 18; hints.push({ type: "bad",  text: `Too long — may be clipped (${len} chars)` }); }

  // Spam triggers
  const lower = s.toLowerCase();
  const hits = SPAM_TRIGGERS.filter((t) => lower.includes(t));
  if (hits.length > 0) {
    score -= Math.min(35, hits.length * 12);
    hints.push({ type: "bad", text: `Spam trigger${hits.length > 1 ? "s" : ""}: "${hits.slice(0, 2).join('", "')}"` });
  }

  // ALL CAPS words
  const capsWords = s.match(/\b[A-Z]{3,}\b/g) ?? [];
  if (capsWords.length > 1) { score -= 12; hints.push({ type: "bad",  text: "Multiple ALL-CAPS words hurt deliverability" }); }
  else if (capsWords.length === 1) { score -= 4; hints.push({ type: "warn", text: `ALL-CAPS word detected: "${capsWords[0]}"` }); }

  // Excessive punctuation
  if (/[!?]{2,}/.test(s)) { score -= 10; hints.push({ type: "bad", text: "Avoid repeated ! or ?" }); }
  else if (/[!]/.test(s)) { score -= 3;  hints.push({ type: "warn", text: "Exclamation points reduce trust" }); }

  // Emojis
  const emojiCount = [...s].filter((c) => /\p{Emoji}/u.test(c) && c !== ' ').length;
  if (emojiCount > 3)      { score -= 8;  hints.push({ type: "warn", text: `${emojiCount} emojis — keep to 1–2` }); }
  else if (emojiCount > 0) { score += 4;  hints.push({ type: "ok",   text: `${emojiCount} emoji — nice` }); }

  // Personalization
  if (/\{\{/.test(s)) { score += 8; hints.push({ type: "ok", text: "Personalization variable boosts open rates" }); }

  // Numbers
  if (/\d/.test(s)) { score += 4; hints.push({ type: "ok", text: "Numbers draw attention" }); }

  // Question
  if (s.trimEnd().endsWith("?")) { score += 3; hints.push({ type: "ok", text: "Question format can increase curiosity" }); }

  return { score: Math.max(0, Math.min(100, score)), hints: hints.slice(0, 4) };
}

function SubjectScorer({ subject }: { subject: string }) {
  if (!subject.trim()) return null;
  const { score, hints } = scoreSubject(subject);
  const color = score >= 75 ? "oklch(0.55 0.16 145)" : score >= 50 ? "oklch(0.65 0.18 75)" : "oklch(0.55 0.22 25)";
  const label = score >= 75 ? "Strong" : score >= 50 ? "Fair" : "Needs work";
  return (
    <div className="mt-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${score}%`, background: color }} />
        </div>
        <span className="text-xs font-medium shrink-0 tabular-nums" style={{ color }}>{score}/100 · {label}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {hints.map((h, i) => (
          <span key={i} className="text-[11px] leading-relaxed" style={{ color: h.type === "ok" ? "oklch(0.55 0.16 145)" : h.type === "warn" ? "oklch(0.60 0.18 75)" : "oklch(0.55 0.22 25)" }}>
            {h.type === "ok" ? "✓" : "⚠"} {h.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dashboard/campaigns")({
  head: () => ({ meta: [{ title: "Campaigns — Continuum API" }] }),
  component: CampaignsPage,
});

interface DeepGenEmail {
  segmentLabel: string;
  matchCount: number;
  matchPct: number;
  subject: string;
  textBody: string;
  htmlBody: string;
  hookUsed: string;
  revised: boolean;
}

interface Campaign {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  subjectB?: string | null;
  status: string;
  totalRecipients: number;
  sentCount: number;
  openCount: number;
  clickCount: number;
  openCountB: number;
  clickCountB: number;
  bounceCount: number;
  complaintCount: number;
  trackOpens: boolean;
  trackClicks: boolean;
  createdAt: string;
  scheduledAt: string | null;
  sentAt: string | null;
}

interface MailingList { id: string; name: string; }
interface EmailTemplate { id: string; name: string; subject: string; htmlBody: string; }
interface Segment { id: string; name: string; }
interface SendingDomain { id: string; name: string; status: string; }
interface CampaignHealth {
  health_score: number;
  signals: Array<{ type: "warning" | "critical" | "good"; message: string }>;
  metrics: {
    total_recipients: number; sent: number; delivered: number;
    opened: number; clicked: number; bounced: number; complained: number;
    delivery_rate: number; open_rate: number; click_rate: number;
    bounce_rate: number; complaint_rate: number;
  };
}

// ── Rich Email Editor ─────────────────────────────────────────────────────────

type EditorMode = "visual" | "html";

function RichEmailEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalUpdate = useRef(false);

  // Sync external value changes into the visual editor (e.g. AI fill, template load)
  useEffect(() => {
    if (mode === "visual" && editorRef.current && !isInternalUpdate.current) {
      if (editorRef.current.innerHTML !== value) {
        editorRef.current.innerHTML = value;
      }
    }
  }, [value, mode]);

  const handleVisualInput = useCallback(() => {
    if (!editorRef.current) return;
    isInternalUpdate.current = true;
    onChange(editorRef.current.innerHTML);
    setTimeout(() => { isInternalUpdate.current = false; }, 0);
  }, [onChange]);

  const exec = useCallback((command: string, val?: string) => {
    document.execCommand(command, false, val);
    editorRef.current?.focus();
    handleVisualInput();
  }, [handleVisualInput]);

  const insertLink = useCallback(() => {
    const url = prompt("Enter URL:");
    if (url) exec("createLink", url.startsWith("http") ? url : `https://${url}`);
  }, [exec]);

  const switchMode = (m: EditorMode) => {
    if (m === mode) return;
    // When switching to HTML view, value is already up-to-date from visual input
    // When switching back to visual, update contenteditable from current value
    setMode(m);
    if (m === "visual") {
      setTimeout(() => {
        if (editorRef.current) editorRef.current.innerHTML = value;
      }, 0);
    }
  };

  const ToolBtn = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {children}
    </button>
  );

  const Sep = () => <div className="w-px h-4 bg-border mx-0.5" />;

  return (
    <div className="rounded-md border border-input overflow-hidden focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border bg-muted/30 flex-wrap">
        {mode === "visual" ? (
          <>
            <ToolBtn onClick={() => exec("bold")} title="Bold"><Bold className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("italic")} title="Italic"><Italic className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("underline")} title="Underline"><Underline className="h-3.5 w-3.5" /></ToolBtn>
            <Sep />
            <ToolBtn onClick={() => exec("insertUnorderedList")} title="Bullet list"><List className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("insertOrderedList")} title="Numbered list"><ListOrdered className="h-3.5 w-3.5" /></ToolBtn>
            <Sep />
            <ToolBtn onClick={() => exec("justifyLeft")} title="Align left"><AlignLeft className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("justifyCenter")} title="Align center"><AlignCenter className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("justifyRight")} title="Align right"><AlignRight className="h-3.5 w-3.5" /></ToolBtn>
            <Sep />
            <ToolBtn onClick={insertLink} title="Insert link"><Link className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("insertHorizontalRule")} title="Horizontal rule"><Minus className="h-3.5 w-3.5" /></ToolBtn>
            <ToolBtn onClick={() => exec("removeFormat")} title="Clear formatting"><X className="h-3.5 w-3.5" /></ToolBtn>
          </>
        ) : (
          <span className="text-xs text-muted-foreground px-1 font-mono">HTML</span>
        )}
        <div className="ml-auto flex items-center gap-0">
          <button
            type="button"
            onClick={() => switchMode("visual")}
            className={cn("px-2.5 py-1 text-xs rounded-l-md border transition-colors", mode === "visual" ? "bg-foreground text-background border-foreground" : "bg-transparent text-muted-foreground border-border hover:bg-muted")}
          >
            Visual
          </button>
          <button
            type="button"
            onClick={() => switchMode("html")}
            className={cn("px-2.5 py-1 text-xs rounded-r-md border-y border-r transition-colors flex items-center gap-1", mode === "html" ? "bg-foreground text-background border-foreground" : "bg-transparent text-muted-foreground border-border hover:bg-muted")}
          >
            <Code2 className="h-3 w-3" /> HTML
          </button>
        </div>
      </div>

      {/* Visual editor */}
      {mode === "visual" && (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleVisualInput}
          className="min-h-[160px] px-3 py-2.5 text-sm outline-none leading-relaxed [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
          style={{ fontFamily: "inherit" }}
          data-placeholder={placeholder ?? "<p>Hi {{first_name}},</p>"}
        />
      )}

      {/* HTML source view */}
      {mode === "html" && (
        <textarea
          className="w-full min-h-[160px] px-3 py-2.5 text-sm font-mono resize-y outline-none bg-background"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "<p>Hi {{first_name}},</p>"}
          spellCheck={false}
        />
      )}
    </div>
  );
}

function CampaignsPage() {
  const { primaryKey } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", fromName: "", fromEmail: "", replyTo: "", subject: "", subjectB: "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: true, trackClicks: true, scheduledAt: "", sendRatePerHour: "", sendDays: ["monday","tuesday","wednesday","thursday","friday"] as string[], sendStartHour: "8", sendEndHour: "17", timezone: "UTC" });
  const [saving, setSaving] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [testTarget, setTestTarget] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [confirmCampaign, setConfirmCampaign] = useState<Campaign | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [healthCampaign, setHealthCampaign] = useState<Campaign | null>(null);
  const [health, setHealth] = useState<CampaignHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [spamResult, setSpamResult] = useState<{ campaign_id: string; spam_score: number; verdict: string; flags: Array<{ severity: string; message: string }> } | null>(null);
  const [spamLoading, setSpamLoading] = useState(false);
  const [retargetResult, setRetargetResult] = useState<{ campaign_id?: string; non_openers: number; total_sent?: number; message: string } | null>(null);
  const [retargetLoading, setRetargetLoading] = useState(false);
  const [recipientsCampaign, setRecipientsCampaign] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Array<{ id: string; email: string; status: string; variant: string; sentAt: string | null; openedAt: string | null; clickedAt: string | null }>>([]);
  const [recipientsTotal, setRecipientsTotal] = useState(0);
  const [recipientsPage, setRecipientsPage] = useState(1);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsSearch, setRecipientsSearch] = useState("");
  const [resumingCampaign, setResumingCampaign] = useState<string | null>(null);
  const [pickingWinner, setPickingWinner] = useState<string | null>(null);
  const [aiBriefText, setAiBriefText] = useState("");
  const [aiBriefTone, setAiBriefTone] = useState<"professional" | "casual" | "direct" | "technical">("professional");
  const [subjectIdeas, setSubjectIdeas] = useState<string[]>([]);
  const [subjectIdeasLoading, setSubjectIdeasLoading] = useState(false);
  const [showSubjectIdeas, setShowSubjectIdeas] = useState(false);
  // Deep-generate: segment-grounded, knowledge-base-reviewed drafts — the
  // real feature, replacing the old single-generic-draft "Draft with AI".
  const [deepGenLoading, setDeepGenLoading] = useState(false);
  const [deepGenResults, setDeepGenResults] = useState<DeepGenEmail[] | null>(null);
  const [deepGenTotalContacts, setDeepGenTotalContacts] = useState(0);
  const [deepGenAppliedIdx, setDeepGenAppliedIdx] = useState<number | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: Campaign[] }>("/v1/campaigns?page=1&limit=50", primaryKey.keyRaw)
      .then((r) => setCampaigns(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
    api.withKey
      .get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: EmailTemplate[] }>("/v1/templates?limit=50", primaryKey.keyRaw)
      .then((r) => setTemplates(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: Segment[] }>("/v1/segments", primaryKey.keyRaw)
      .then((r) => setSegments(r.data ?? []))
      .catch(() => {});
    api.withKey
      .get<{ data: SendingDomain[] }>("/v1/domains", primaryKey.keyRaw)
      .then((r) => setDomains((r.data ?? []).filter((d) => d.status === "verified")))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [primaryKey]);

  const resetForm = () => setForm({ name: "", fromName: "", fromEmail: "", replyTo: "", subject: "", subjectB: "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: true, trackClicks: true, scheduledAt: "", sendRatePerHour: "", sendDays: ["monday","tuesday","wednesday","thursday","friday"] as string[], sendStartHour: "8", sendEndHour: "17", timezone: "UTC" });

  const openHealth = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setHealthCampaign(c);
    setHealth(null);
    setHealthLoading(true);
    try {
      const h = await api.withKey.get<CampaignHealth>(`/v1/campaigns/${c.id}/health`, primaryKey.keyRaw);
      setHealth(h);
    } catch { toast.error("Could not load campaign health"); }
    finally { setHealthLoading(false); }
  };

  const runSpamCheck = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setSpamLoading(true);
    setSpamResult(null);
    try {
      const r = await api.withKey.post<typeof spamResult>(`/v1/campaigns/${c.id}/spam-check`, {}, primaryKey.keyRaw);
      setSpamResult(r);
    } catch { toast.error("Could not run spam check"); }
    finally { setSpamLoading(false); }
  };

  const runRetarget = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setRetargetLoading(true);
    setRetargetResult(null);
    try {
      const r = await api.withKey.post<{ campaign_id?: string; non_openers: number; total_sent?: number; message: string }>(`/v1/campaigns/${c.id}/retarget`, {}, primaryKey.keyRaw);
      setRetargetResult(r);
      if (r.campaign_id) { toast.success("Retarget campaign created as draft"); load(); }
      else toast.info(r.message);
    } catch { toast.error("Could not create retarget campaign"); }
    finally { setRetargetLoading(false); }
  };

  const loadRecipients = async (campaignId: string, page = 1, search = "") => {
    if (!primaryKey?.keyRaw) return;
    setRecipientsLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: "50" });
      if (search) qs.set("search", search);
      const r = await api.withKey.get<{ total: number; page: number; data: typeof recipients }>(`/v1/campaigns/${campaignId}/recipients?${qs}`, primaryKey.keyRaw);
      setRecipients(r.data ?? []);
      setRecipientsTotal(r.total ?? 0);
      setRecipientsPage(r.page ?? 1);
    } catch { toast.error("Could not load recipients"); }
    finally { setRecipientsLoading(false); }
  };

  const openRecipients = (c: Campaign) => {
    setRecipientsCampaign(c.id);
    setRecipients([]);
    setRecipientsTotal(0);
    setRecipientsPage(1);
    setRecipientsSearch("");
    loadRecipients(c.id, 1, "");
  };

  const pickWinner = async (c: Campaign, variant: "a" | "b") => {
    if (!primaryKey?.keyRaw) return;
    const label = variant === "a" ? c.subject : c.subjectB;
    if (!confirm(`Lock in variant ${variant.toUpperCase()} ("${label}") for all remaining pending recipients?`)) return;
    setPickingWinner(c.id);
    try {
      const r = await api.withKey.post<{ winner: string; updated_recipients: number }>(`/v1/campaigns/${c.id}/pick-winner`, { variant }, primaryKey.keyRaw);
      toast.success(`Variant ${variant.toUpperCase()} locked in — ${r.updated_recipients} pending recipients updated`);
      load();
    } catch { toast.error("Could not pick winner"); }
    finally { setPickingWinner(null); }
  };

  const resumeCampaign = async (c: Campaign) => {
    if (!primaryKey?.keyRaw) return;
    setResumingCampaign(c.id);
    try {
      await api.withKey.post(`/v1/campaigns/${c.id}/resume`, {}, primaryKey.keyRaw);
      toast.success("Campaign resumed");
      load();
    } catch { toast.error("Could not resume campaign"); }
    finally { setResumingCampaign(null); }
  };

  const autoTextBody = () => {
    const plain = form.htmlBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    setForm((f) => ({ ...f, textBody: plain }));
  };

  // Deep-generate: pulls the ACTUAL target list, derives real segments from
  // whatever signal is genuinely present in it (industry, title/seniority —
  // never a hypothetical audience), and generates one grounded,
  // knowledge-base-reviewed draft per segment via /v1/campaigns/generate-copy.
  // Segment-level by design (see the backend route's own comment) — not
  // per-recipient live generation, which is separate future work.
  const generateDeepCopy = async () => {
    if (!primaryKey?.keyRaw || !aiBriefText.trim()) return;
    if (!form.listId) {
      toast.error("Pick a target list first — deep generation reads the real list to find genuine segments to write for.");
      return;
    }
    setDeepGenLoading(true);
    setDeepGenResults(null);
    setDeepGenAppliedIdx(null);
    try {
      const data = await api.withKey.post<{ totalContacts: number; emails: DeepGenEmail[] }>(
        "/v1/campaigns/generate-copy",
        {
          about: aiBriefText,
          sender: form.fromName ? { name: form.fromName, company: form.fromName } : undefined,
          tone: aiBriefTone,
          list_ids: [form.listId],
        },
        primaryKey.keyRaw,
      );
      setDeepGenResults(data.emails ?? []);
      setDeepGenTotalContacts(data.totalContacts ?? 0);
      if (!data.emails?.length) toast.info("No segments could be generated for this list.");
    } catch (err: unknown) {
      toast.error((err as { message?: string }).message ?? "Deep generation failed — check your plan or try again.");
    } finally {
      setDeepGenLoading(false);
    }
  };

  const applyDeepGenDraft = (email: DeepGenEmail, idx: number) => {
    setForm((f) => ({ ...f, subject: email.subject, htmlBody: email.htmlBody, textBody: email.textBody }));
    setDeepGenAppliedIdx(idx);
    toast.success(`Applied the "${email.segmentLabel}" draft — review and edit before sending`);
  };

  const generateSubjectIdeas = async () => {
    if (!primaryKey?.keyRaw) return;
    setSubjectIdeasLoading(true);
    setShowSubjectIdeas(true);
    setSubjectIdeas([]);
    try {
      const about = form.htmlBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 300).trim()
        || form.subject || "email campaign";
      // The quick subject-ideas helper still uses the older, simpler
      // generate-email endpoint (its tone enum predates direct/technical) —
      // map onto its closest supported tone rather than failing the call.
      const legacyTone = aiBriefTone === "direct" || aiBriefTone === "technical" ? "professional" : aiBriefTone;
      const res = await fetch("https://api.continuumapi.com/v1/ai/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw },
        body: JSON.stringify({ type: "newsletter", about, tone: legacyTone, subject_only: true, num_variants: 5 }),
      });
      if (!res.ok) { toast.error("Subject generation failed"); setShowSubjectIdeas(false); return; }
      const data = await res.json() as { variants?: Array<{ subject: string }> };
      const ideas = (data.variants ?? []).map((v) => v.subject).filter(Boolean);
      setSubjectIdeas(ideas);
      if (ideas.length === 0) toast.info("No ideas generated — try adding more email content first.");
    } catch { toast.error("Subject generation failed"); setShowSubjectIdeas(false); }
    finally { setSubjectIdeasLoading(false); }
  };

  const create = async (asDraft = true) => {
    if (!primaryKey?.keyRaw) return;
    if (!form.fromName || !form.fromEmail || !form.subject || !form.htmlBody) {
      toast.error("Fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name || form.subject,
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        subject_b: form.subjectB || undefined,
        preheader: form.preheader || undefined,
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
        segment_ids: form.segmentId ? [form.segmentId] : [],
        exclude_list_ids: form.excludeListId ? [form.excludeListId] : [],
        reply_to: form.replyTo || undefined,
        text_body: form.textBody || undefined,
        track_opens: form.trackOpens,
        track_clicks: form.trackClicks,
        domain_id: form.domainId || undefined,
      };
      if (!asDraft && form.scheduledAt) payload.scheduled_at = new Date(form.scheduledAt).toISOString();
      if (form.sendRatePerHour) payload.send_rate_per_hour = parseInt(form.sendRatePerHour, 10);
      if (form.sendDays.length > 0) payload.send_days = form.sendDays;
      payload.send_start_hour = parseInt(form.sendStartHour, 10);
      payload.send_end_hour = parseInt(form.sendEndHour, 10);
      payload.timezone = form.timezone;
      const campaign = await api.withKey.post<{ id: string }>("/v1/campaigns", payload, primaryKey.keyRaw);
      if (!asDraft && !form.scheduledAt) {
        await api.withKey.post(`/v1/campaigns/${campaign.id}/send`, {}, primaryKey.keyRaw);
        toast.success("Campaign queued for sending");
      } else if (!asDraft && form.scheduledAt) {
        await api.withKey.post(`/v1/campaigns/${campaign.id}/send`, {}, primaryKey.keyRaw);
        toast.success(`Campaign scheduled for ${new Date(form.scheduledAt).toLocaleString()}`);
      } else {
        toast.success("Campaign saved as draft");
      }
      setCreating(false);
      resetForm();
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateCampaign = async () => {
    if (!primaryKey?.keyRaw || !editingCampaign) return;
    setSaving(true);
    try {
      await api.withKey.patch(`/v1/campaigns/${editingCampaign.id}`, {
        name: form.name || form.subject,
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        subject_b: form.subjectB || undefined,
        preheader: form.preheader || undefined,
        html_body: form.htmlBody,
        list_ids: form.listId ? [form.listId] : [],
        reply_to: form.replyTo || undefined,
        text_body: form.textBody || undefined,
        track_opens: form.trackOpens,
        track_clicks: form.trackClicks,
        ...(form.scheduledAt ? { scheduled_at: new Date(form.scheduledAt).toISOString() } : {}),
        ...(form.sendRatePerHour ? { send_rate_per_hour: parseInt(form.sendRatePerHour, 10) } : {}),
        send_days: form.sendDays,
        send_start_hour: parseInt(form.sendStartHour, 10),
        send_end_hour: parseInt(form.sendEndHour, 10),
        timezone: form.timezone,
      }, primaryKey.keyRaw);
      toast.success("Campaign updated");
      setEditingCampaign(null);
      resetForm();
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const cancelSchedule = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await api.withKey.post(`/v1/campaigns/${id}/cancel`, {}, primaryKey.keyRaw);
      toast.success("Campaign reverted to draft");
      setCampaigns((c) => c.map((x) => x.id === id ? { ...x, status: "draft", scheduledAt: null } : x));
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const sendCampaign = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    setConfirming(true);
    try {
      await api.withKey.post(`/v1/campaigns/${id}/send`, {}, primaryKey.keyRaw);
      toast.success("Campaign queued for sending");
      setCampaigns((c) => c.map((x) => x.id === id ? { ...x, status: "sending" } : x));
      setConfirmCampaign(null);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const duplicate = async (id: string) => {
    if (!primaryKey?.keyRaw) return;
    try {
      await fetch(`https://api.continuumapi.com/v1/campaigns/${id}/duplicate`, {
        method: "POST",
        headers: { "X-API-Key": primaryKey.keyRaw! },
      });
      toast.success("Campaign duplicated as draft");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  const sendTest = async () => {
    if (!primaryKey?.keyRaw || !testTarget || !testEmail) return;
    setTestSending(true);
    try {
      await api.withKey.post(`/v1/campaigns/${testTarget}/test`, { to: testEmail }, primaryKey.keyRaw);
      toast.success(`Test sent to ${testEmail}`);
      setTestTarget(null);
      setTestEmail("");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setTestSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Newsletter and broadcast emails to your mailing lists.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New Campaign
        </Button>
      </div>

      {(creating || editingCampaign) && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
          <h2 className="text-sm font-semibold">{editingCampaign ? "Edit Campaign" : "New Campaign"}</h2>
          {!editingCampaign && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-medium">Deep-generate with AI</p>
                <span className="text-[10px] text-muted-foreground">— reads your actual list, writes per-segment, no generic filler</span>
              </div>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                rows={2}
                placeholder="Describe the offer — e.g. 'A pentesting-as-a-service tool for security teams at Series B+ companies'"
                value={aiBriefText}
                onChange={(e) => setAiBriefText(e.target.value)}
              />
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none"
                  value={aiBriefTone}
                  onChange={(e) => setAiBriefTone(e.target.value as typeof aiBriefTone)}
                >
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="direct">Direct</option>
                  <option value="technical">Technical (security/eng audiences)</option>
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7"
                  disabled={!aiBriefText.trim() || deepGenLoading}
                  onClick={generateDeepCopy}
                >
                  <Sparkles className="h-3 w-3" />
                  {deepGenLoading ? "Researching your list…" : "Generate segment drafts"}
                </Button>
              </div>
              {!form.listId && (
                <p className="text-xs text-amber-600 dark:text-amber-400">Pick a target list below first — segments are derived from the real list, not a guess.</p>
              )}

              {deepGenResults && deepGenResults.length > 0 && (
                <div className="space-y-2 pt-1">
                  <p className="text-xs text-muted-foreground">
                    Found {deepGenResults.length} segment{deepGenResults.length > 1 ? "s" : ""} in {deepGenTotalContacts} contacts — pick the draft that fits, then edit before sending.
                  </p>
                  {deepGenResults.map((email, idx) => (
                    <div key={idx} className={`rounded-md border p-3 space-y-1.5 ${deepGenAppliedIdx === idx ? "border-violet-400 bg-violet-50 dark:bg-violet-950/30" : "border-border bg-background"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold">{email.segmentLabel}</span>
                          <span className="text-[10px] text-muted-foreground">{email.matchPct}% of list ({email.matchCount})</span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={deepGenAppliedIdx === idx ? "secondary" : "outline"}
                          className="text-xs h-6"
                          onClick={() => applyDeepGenDraft(email, idx)}
                        >
                          {deepGenAppliedIdx === idx ? "Applied" : "Use this draft"}
                        </Button>
                      </div>
                      <p className="text-xs font-medium">{email.subject}</p>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{email.textBody}</p>
                      <p className="text-[10px] text-muted-foreground italic">Hook: {email.hookUsed}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Campaign name</Label>
            <Input placeholder="May Newsletter" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From name</Label>
              <Input placeholder="Acme Inc." value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>From email</Label>
              <Input placeholder="hello@acme.com" value={form.fromEmail} onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))} />
            </div>
          </div>
          {domains.length > 0 && (
            <div className="space-y-1.5">
              <Label>Sending domain <span className="text-muted-foreground font-normal">(optional — defaults to account default)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.domainId}
                onChange={(e) => setForm((f) => ({ ...f, domainId: e.target.value }))}
              >
                <option value="">— account default —</option>
                {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Reply-to <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input placeholder="replies@acme.com" type="email" value={form.replyTo} onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Subject <span className="text-muted-foreground font-normal">(Variant A)</span></Label>
              <button
                type="button"
                onClick={generateSubjectIdeas}
                disabled={subjectIdeasLoading}
                className="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {subjectIdeasLoading ? "Generating…" : "Get AI ideas"}
              </button>
            </div>
            <Input placeholder="Your May update is here" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
            <SubjectScorer subject={form.subject} />
            {showSubjectIdeas && (
              <div className="rounded-md border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-violet-700 dark:text-violet-300">AI subject ideas — click to use</p>
                  <button type="button" onClick={() => setShowSubjectIdeas(false)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {subjectIdeasLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                    <Sparkles className="h-3.5 w-3.5 animate-pulse text-violet-500" /> Generating 5 subject ideas…
                  </div>
                ) : subjectIdeas.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No ideas yet.</p>
                ) : (
                  <div className="space-y-1">
                    {subjectIdeas.map((idea, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => { setForm((f) => ({ ...f, subject: idea })); setShowSubjectIdeas(false); }}
                        className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-violet-100 dark:hover:bg-violet-900/40 text-foreground transition-colors"
                      >
                        {idea}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Subject B <span className="text-muted-foreground font-normal">(optional — leave blank to skip A/B test)</span></Label>
            <Input
              placeholder="Don't miss your exclusive May offer"
              value={form.subjectB}
              onChange={(e) => setForm((f) => ({ ...f, subjectB: e.target.value }))}
            />
            {form.subjectB && (
              <p className="text-xs text-muted-foreground">A/B test active — 50% of recipients will receive Subject B</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Preheader <span className="text-muted-foreground font-normal">(optional — inbox preview text shown after the subject line)</span></Label>
            <Input
              placeholder="Grab your exclusive offer before it expires..."
              value={form.preheader}
              onChange={(e) => setForm((f) => ({ ...f, preheader: e.target.value }))}
              maxLength={200}
            />
            {form.preheader && (
              <p className="text-xs text-muted-foreground">{form.preheader.length}/200 chars</p>
            )}
          </div>
          {lists.length > 0 && (
            <div className="space-y-1.5">
              <Label>Mailing list</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.listId}
                onChange={(e) => setForm((f) => ({ ...f, listId: e.target.value }))}
              >
                <option value="">— choose a list —</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          {segments.length > 0 && !editingCampaign && (
            <div className="space-y-1.5">
              <Label>Filter by segment <span className="text-muted-foreground font-normal">(optional — narrows the list to matching contacts)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.segmentId}
                onChange={(e) => setForm((f) => ({ ...f, segmentId: e.target.value }))}
              >
                <option value="">— all subscribers in the list —</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {templates.length > 0 && !editingCampaign && (
            <div className="space-y-1.5">
              <Label>Load from template <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                defaultValue=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t) setForm((f) => ({ ...f, subject: t.subject, htmlBody: t.htmlBody }));
                }}
              >
                <option value="">— pick a saved template —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Email body</Label>
              {form.htmlBody && (
                <button onClick={() => setPreview(true)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <Eye className="h-3 w-3" /> Preview
                </button>
              )}
            </div>
            <RichEmailEditor
              value={form.htmlBody}
              onChange={(html) => setForm((f) => ({ ...f, htmlBody: html }))}
              placeholder="<p>Hi {{first_name}},</p>"
            />
            <p className="text-xs text-muted-foreground">Use {"{{first_name}}"}, {"{{email}}"}, {"{{unsubscribe_url}}"} as personalization tokens.</p>
          </div>
          {lists.length > 0 && (
            <div className="space-y-1.5">
              <Label>Exclude list <span className="text-muted-foreground font-normal">(optional — these contacts will not receive the campaign)</span></Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={form.excludeListId}
                onChange={(e) => setForm((f) => ({ ...f, excludeListId: e.target.value }))}
              >
                <option value="">— no exclusion list —</option>
                {lists.filter((l) => l.id !== form.listId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Plain text body <span className="text-muted-foreground font-normal">(optional — recommended for deliverability)</span></Label>
              {form.htmlBody && (
                <button type="button" onClick={autoTextBody} className="text-xs text-muted-foreground hover:text-foreground">Auto-generate from HTML</button>
              )}
            </div>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Hi {{first_name}}, ..."
              value={form.textBody}
              onChange={(e) => setForm((f) => ({ ...f, textBody: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-foreground h-4 w-4" checked={form.trackOpens} onChange={(e) => setForm((f) => ({ ...f, trackOpens: e.target.checked }))} />
              <span className="text-sm">Track opens</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-foreground h-4 w-4" checked={form.trackClicks} onChange={(e) => setForm((f) => ({ ...f, trackClicks: e.target.checked }))} />
              <span className="text-sm">Track clicks</span>
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-muted-foreground" /> Schedule send <span className="text-muted-foreground font-normal">(optional — leave blank to save as draft)</span></Label>
            <Input
              type="datetime-local"
              value={form.scheduledAt}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(e) => setForm((f) => ({ ...f, scheduledAt: e.target.value }))}
              className="w-64"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">Send rate limit <span className="text-muted-foreground font-normal">(optional — emails per hour for warm-up)</span></Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="10"
                max="50000"
                placeholder="Unlimited"
                value={form.sendRatePerHour}
                onChange={(e) => setForm((f) => ({ ...f, sendRatePerHour: e.target.value }))}
                className="w-40"
              />
              <span className="text-xs text-muted-foreground">emails/hr</span>
            </div>
            {form.sendRatePerHour && parseInt(form.sendRatePerHour, 10) > 0 && (
              <p className="text-xs text-muted-foreground">At this rate, a 50-recipient chunk sends every {Math.round((50 / parseInt(form.sendRatePerHour, 10)) * 60)} min.</p>
            )}
          </div>
          <div className="space-y-2.5">
            <div>
              <Label>Send Window <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <p className="text-xs text-muted-foreground mt-0.5">Restrict sends to specific days and hours</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const).map((day) => {
                const label = day.charAt(0).toUpperCase() + day.slice(1, 3);
                const active = form.sendDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, sendDays: active ? f.sendDays.filter((d) => d !== day) : [...f.sendDays, day] }))}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${active ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">From hour</p>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={form.sendStartHour}
                  onChange={(e) => setForm((f) => ({ ...f, sendStartHour: e.target.value }))}
                >
                  {Array.from({ length: 24 }, (_, h) => {
                    const label = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
                    return <option key={h} value={String(h)}>{label}</option>;
                  })}
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">To hour</p>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={form.sendEndHour}
                  onChange={(e) => setForm((f) => ({ ...f, sendEndHour: e.target.value }))}
                >
                  {Array.from({ length: 24 }, (_, h) => {
                    const label = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
                    return <option key={h} value={String(h)}>{label}</option>;
                  })}
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Timezone</p>
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                >
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="Asia/Kolkata">Asia/Kolkata</option>
                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                  <option value="Australia/Sydney">Australia/Sydney</option>
                </select>
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {editingCampaign ? (
              <Button onClick={updateCampaign} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
            ) : form.scheduledAt ? (
              <Button onClick={() => create(false)} disabled={saving} className="gap-1.5">
                <Clock className="h-3.5 w-3.5" />{saving ? "Scheduling…" : `Schedule for ${new Date(form.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
              </Button>
            ) : (
              <>
                <Button onClick={() => create(true)} disabled={saving} variant="outline">{saving ? "Saving…" : "Save as Draft"}</Button>
                <Button onClick={() => create(false)} disabled={saving} className="gap-1.5">
                  <Send className="h-3.5 w-3.5" />{saving ? "Sending…" : "Send Now"}
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => { setCreating(false); setEditingCampaign(null); resetForm(); }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* HTML preview modal */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-card border border-border rounded-lg shadow-2xl flex flex-col w-full max-w-4xl h-[80vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium mr-3">Email Preview</span>
                <button
                  onClick={() => setPreviewDevice("desktop")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${previewDevice === "desktop" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Monitor className="h-3.5 w-3.5" /> Desktop
                </button>
                <button
                  onClick={() => setPreviewDevice("mobile")}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${previewDevice === "mobile" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Smartphone className="h-3.5 w-3.5" /> Mobile
                </button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground truncate max-w-[300px]">Subject: {form.subject || "(no subject)"}</span>
                <button onClick={() => setPreview(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[oklch(0.93_0.005_270)] flex items-start justify-center py-6">
              <div
                className={`bg-white shadow-lg transition-all ${previewDevice === "mobile" ? "w-[375px]" : "w-full max-w-[680px]"}`}
                style={{ minHeight: "400px" }}
              >
                <iframe
                  srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#111}a{color:#0070f3}</style></head><body>${form.htmlBody}</body></html>`}
                  className="w-full border-0"
                  style={{ minHeight: "400px", height: "100%" }}
                  sandbox="allow-same-origin"
                  title="Email preview"
                  onLoad={(e) => {
                    const iframe = e.currentTarget;
                    iframe.style.height = (iframe.contentDocument?.body?.scrollHeight ?? 400) + "px";
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Test send modal */}
      {testTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-sm space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Send Test Email</h2>
              <button onClick={() => { setTestTarget(null); setTestEmail(""); }} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-1.5">
              <Label>Send test to</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendTest(); }}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={sendTest} disabled={testSending || !testEmail} className="gap-1.5">
                <FlaskConical className="h-3.5 w-3.5" />
                {testSending ? "Sending…" : "Send Test"}
              </Button>
              <Button variant="outline" onClick={() => { setTestTarget(null); setTestEmail(""); }}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Send confirmation modal */}
      {confirmCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Confirm Send</h2>
              <button onClick={() => setConfirmCampaign(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subject</span>
                <span className="font-medium max-w-[240px] truncate text-right">{confirmCampaign.subject}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">From</span>
                <span className="font-medium">{confirmCampaign.fromName} &lt;{confirmCampaign.fromEmail}&gt;</span>
              </div>
              {confirmCampaign.scheduledAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Scheduled</span>
                  <span className="font-medium">{new Date(confirmCampaign.scheduledAt).toLocaleString()}</span>
                </div>
              )}
              <div className="border-t border-border pt-2 flex justify-between items-center">
                <span className="text-muted-foreground flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Recipients</span>
                <span className="font-semibold tabular-nums text-base">{confirmCampaign.totalRecipients.toLocaleString()}</span>
              </div>
            </div>
            {/* Pre-flight checklist */}
            {(() => {
              const checks: Array<{ label: string; pass: boolean; warn?: boolean }> = [
                { label: "Recipients > 0", pass: confirmCampaign.totalRecipients > 0 },
                { label: "Subject line set", pass: Boolean(confirmCampaign.subject) },
                { label: "Subject ≤ 60 chars", pass: confirmCampaign.subject.length <= 60, warn: true },
                { label: "From address set", pass: Boolean(confirmCampaign.fromEmail) },
              ];
              const anyFail = checks.some((c) => !c.pass && !c.warn);
              const anyWarn = checks.some((c) => !c.pass && c.warn);
              if (anyFail || anyWarn) return (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Pre-flight</p>
                  <div className="space-y-1">
                    {checks.map((c) => (
                      <div key={c.label} className={`flex items-center gap-2 text-xs ${c.pass ? "text-[oklch(0.45_0.13_145)]" : c.warn ? "text-[oklch(0.55_0.14_75)]" : "text-[oklch(0.52_0.2_27)]"}`}>
                        {c.pass
                          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
                        {c.label}
                      </div>
                    ))}
                  </div>
                </div>
              );
              return null;
            })()}
            {confirmCampaign.totalRecipients === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                No recipients found. Make sure this campaign is linked to a mailing list with active subscribers.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              This campaign will be sent immediately to{" "}
              <strong>{confirmCampaign.totalRecipients.toLocaleString()} subscriber{confirmCampaign.totalRecipients !== 1 ? "s" : ""}</strong>.
              This action cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => sendCampaign(confirmCampaign.id)}
                disabled={confirming || confirmCampaign.totalRecipients === 0}
                className="gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {confirming ? "Sending…" : `Send to ${confirmCampaign.totalRecipients.toLocaleString()} subscriber${confirmCampaign.totalRecipients !== 1 ? "s" : ""}`}
              </Button>
              <Button variant="outline" onClick={() => setConfirmCampaign(null)} disabled={confirming}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-48 bg-muted rounded animate-pulse" />
              <div className="h-3 w-16 bg-muted rounded animate-pulse" />
              <div className="h-3 w-12 bg-muted rounded animate-pulse ml-auto" />
              <div className="h-3 w-12 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Megaphone className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No campaigns yet. Create your first newsletter campaign.</p>
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Create Campaign</Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                <th className="px-5 py-3 font-medium">Campaign</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Recipients</th>
                <th className="px-5 py-3 font-medium">Open rate</th>
                <th className="px-5 py-3 font-medium">Click rate</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const half = c.sentCount > 0 ? Math.ceil(c.sentCount / 2) : 0;
                const halfB = c.sentCount > 0 ? Math.floor(c.sentCount / 2) : 0;
                const openRate = c.sentCount > 0 ? ((c.openCount / c.sentCount) * 100).toFixed(1) : "—";
                const clickRate = c.sentCount > 0 ? ((c.clickCount / c.sentCount) * 100).toFixed(1) : "—";
                const isAB = !!c.subjectB;
                const openRateA = half > 0 ? ((c.openCount / half) * 100).toFixed(1) : "—";
                const clickRateA = half > 0 ? ((c.clickCount / half) * 100).toFixed(1) : "—";
                const openRateB = halfB > 0 ? ((c.openCountB / halfB) * 100).toFixed(1) : "—";
                const clickRateB = halfB > 0 ? ((c.clickCountB / halfB) * 100).toFixed(1) : "—";
                const aWins = isAB && openRateA !== "—" && openRateB !== "—" && parseFloat(openRateA) > parseFloat(openRateB);
                const bWins = isAB && openRateA !== "—" && openRateB !== "—" && parseFloat(openRateB) > parseFloat(openRateA);
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[200px]">{c.subject}</div>
                      {isAB && (
                        <div className="text-xs text-muted-foreground truncate max-w-[200px] mt-0.5">
                          <span className="inline-flex items-center gap-1">
                            <span className="font-mono text-[10px] bg-muted px-1 rounded">B</span>
                            {c.subjectB}
                          </span>
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">{c.fromName} &lt;{c.fromEmail}&gt;</div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={c.status}>{c.status === "paused_bounce" ? "Paused – High Bounce" : c.status === "paused_quota" ? "Paused – Send Quota Reached" : undefined}</StatusBadge>
                    </td>
                    <td className="px-5 py-3 tabular-nums">{c.totalRecipients.toLocaleString()}</td>
                    <td className="px-5 py-3 tabular-nums">
                      {isAB ? (
                        <div className="text-xs space-y-0.5">
                          <div className={aWins ? "font-semibold" : ""}><span className="font-mono text-[10px] text-muted-foreground">A</span> {openRateA}{openRateA !== "—" ? "%" : ""} {aWins && "✓"}</div>
                          <div className={bWins ? "font-semibold" : ""}><span className="font-mono text-[10px] text-muted-foreground">B</span> {openRateB}{openRateB !== "—" ? "%" : ""} {bWins && "✓"}</div>
                        </div>
                      ) : (
                        <>{openRate}{openRate !== "—" ? "%" : ""}</>
                      )}
                    </td>
                    <td className="px-5 py-3 tabular-nums">
                      {isAB ? (
                        <div className="text-xs space-y-0.5">
                          <div><span className="font-mono text-[10px] text-muted-foreground">A</span> {clickRateA}{clickRateA !== "—" ? "%" : ""}</div>
                          <div><span className="font-mono text-[10px] text-muted-foreground">B</span> {clickRateB}{clickRateB !== "—" ? "%" : ""}</div>
                        </div>
                      ) : (
                        <>{clickRate}{clickRate !== "—" ? "%" : ""}</>
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground text-xs">
                      {c.sentAt ? new Date(c.sentAt).toLocaleDateString() : c.scheduledAt ? `Scheduled ${new Date(c.scheduledAt).toLocaleDateString()}` : new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {(c.status === "draft" || c.status === "scheduled") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => {
                            setEditingCampaign(c);
                            setCreating(false);
                            setForm({ name: c.subject, fromName: c.fromName, fromEmail: c.fromEmail, replyTo: "", subject: c.subject, subjectB: c.subjectB ?? "", preheader: "", htmlBody: "", textBody: "", listId: "", segmentId: "", excludeListId: "", domainId: "", trackOpens: c.trackOpens, trackClicks: c.trackClicks, scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16) : "", sendRatePerHour: (c as Campaign & { sendRatePerHour?: number | null }).sendRatePerHour ? String((c as Campaign & { sendRatePerHour?: number | null }).sendRatePerHour) : "", sendDays: (c as Campaign & { sendDays?: string[] }).sendDays ?? ["monday","tuesday","wednesday","thursday","friday"], sendStartHour: String((c as Campaign & { sendStartHour?: number | null }).sendStartHour ?? 8), sendEndHour: String((c as Campaign & { sendEndHour?: number | null }).sendEndHour ?? 17), timezone: (c as Campaign & { timezone?: string }).timezone ?? "UTC" });
                          }}>
                            <Edit2 className="h-3 w-3" /> Edit
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => { setTestTarget(c.id); setTestEmail(""); }}>
                          <FlaskConical className="h-3 w-3" /> Test
                        </Button>
                        {c.status === "draft" && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => runSpamCheck(c)} disabled={spamLoading}>
                            <AlertTriangle className="h-3 w-3" /> Spam
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => duplicate(c.id)}>
                          <Copy className="h-3 w-3" /> Dupe
                        </Button>
                        {c.status === "draft" && (
                          <Button size="sm" variant="outline" className="gap-1 h-7 px-2 text-xs" onClick={() => setConfirmCampaign(c)}>
                            <Send className="h-3 w-3" /> Send
                          </Button>
                        )}
                        {c.status === "scheduled" && (
                          <Button size="sm" variant="outline" className="gap-1 h-7 px-2 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20" onClick={() => cancelSchedule(c.id)}>
                            <XCircle className="h-3 w-3" /> Unschedule
                          </Button>
                        )}
                        {(c.status === "sent" || c.status === "sending") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => openHealth(c)}>
                            <BarChart2 className="h-3 w-3" /> Stats
                          </Button>
                        )}
                        {c.status === "sent" && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => runRetarget(c)} disabled={retargetLoading}>
                            <Target className="h-3 w-3" /> Retarget
                          </Button>
                        )}
                        {c.status === "sent" && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => openRecipients(c)}>
                            <Users className="h-3 w-3" /> Recipients
                          </Button>
                        )}
                        {(c.status === "sending" || c.status === "paused_bounce" || c.status === "paused_quota") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => openRecipients(c)}>
                            <Users className="h-3 w-3" /> Recipients
                          </Button>
                        )}
                        {isAB && (c.status === "sending" || c.status === "paused_bounce" || c.status === "paused_quota") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs" onClick={() => pickWinner(c, aWins ? "a" : "b")} disabled={pickingWinner === c.id} title={`Pick ${aWins ? "A" : bWins ? "B" : "a"} as winner`}>
                            <Trophy className="h-3 w-3" /> Pick Winner
                          </Button>
                        )}
                        {(c.status === "paused_bounce" || c.status === "paused_quota") && (
                          <Button size="sm" variant="ghost" className="gap-1 h-7 px-2 text-xs text-[oklch(0.55_0.16_145)] hover:text-[oklch(0.45_0.16_145)]" onClick={() => resumeCampaign(c)} disabled={resumingCampaign === c.id} title={c.status === "paused_quota" ? "Resume once your monthly send quota has more room" : undefined}>
                            <Play className="h-3 w-3" /> Resume
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recipients drawer */}
      {recipientsCampaign && (
        <div className="fixed inset-0 z-40" onClick={() => setRecipientsCampaign(null)}>
          <div
            className="absolute right-0 top-0 h-full w-[520px] bg-card border-l border-border shadow-2xl overflow-y-auto flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
              <div>
                <p className="font-medium text-sm">Recipients</p>
                <p className="text-xs text-muted-foreground">{recipientsTotal.toLocaleString()} total</p>
              </div>
              <button onClick={() => setRecipientsCampaign(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="px-5 py-3 border-b border-border sticky top-[57px] bg-card z-10">
              <div className="flex gap-2">
                <Input
                  placeholder="Search by email…"
                  value={recipientsSearch}
                  onChange={(e) => {
                    setRecipientsSearch(e.target.value);
                    loadRecipients(recipientsCampaign, 1, e.target.value);
                  }}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {recipientsLoading ? (
                <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">Loading…</div>
              ) : recipients.length === 0 ? (
                <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No recipients found.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/50">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium text-muted-foreground">Email</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Var</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Opened</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Clicked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => (
                      <tr key={r.id} className="border-t border-border hover:bg-muted/20">
                        <td className="px-5 py-2 font-mono truncate max-w-[180px]">{r.email}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2 font-mono uppercase">{r.variant}</td>
                        <td className="px-3 py-2">{r.openedAt ? <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />}</td>
                        <td className="px-3 py-2">{r.clickedAt ? <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(0.55_0.16_145)]" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {recipientsTotal > 50 && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-card">
                <span className="text-xs text-muted-foreground">Page {recipientsPage} of {Math.ceil(recipientsTotal / 50)}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={recipientsPage <= 1 || recipientsLoading} onClick={() => { const p = recipientsPage - 1; setRecipientsPage(p); loadRecipients(recipientsCampaign, p, recipientsSearch); }}>Prev</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={recipientsPage >= Math.ceil(recipientsTotal / 50) || recipientsLoading} onClick={() => { const p = recipientsPage + 1; setRecipientsPage(p); loadRecipients(recipientsCampaign, p, recipientsSearch); }}>Next</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Campaign health drawer */}
      {healthCampaign && (
        <div className="fixed inset-0 z-40" onClick={() => setHealthCampaign(null)}>
          <div
            className="absolute right-0 top-0 h-full w-[420px] bg-card border-l border-border shadow-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <p className="text-sm font-semibold truncate max-w-[300px]">{healthCampaign.subject}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{healthCampaign.fromName} &lt;{healthCampaign.fromEmail}&gt;</p>
              </div>
              <button onClick={() => setHealthCampaign(null)} className="text-muted-foreground hover:text-foreground ml-3 shrink-0">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              {healthLoading ? (
                <div className="space-y-3">
                  {[1,2,3].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
                </div>
              ) : health ? (
                <>
                  {/* Health score */}
                  <div className="flex items-center gap-4">
                    <div className="relative w-16 h-16 shrink-0">
                      <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
                        <circle
                          cx="32" cy="32" r="28" fill="none" strokeWidth="6" strokeLinecap="round"
                          stroke={health.health_score >= 80 ? "oklch(0.55 0.16 145)" : health.health_score >= 50 ? "oklch(0.65 0.16 75)" : "oklch(0.58 0.22 27)"}
                          strokeDasharray={`${(health.health_score / 100) * 175.9} 175.9`}
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">{health.health_score}</span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">
                        {health.health_score >= 80 ? "Healthy" : health.health_score >= 50 ? "At Risk" : "Poor"}
                      </p>
                      <p className="text-xs text-muted-foreground">Deliverability score</p>
                    </div>
                  </div>

                  {/* Signals */}
                  {health.signals.length > 0 && (
                    <div className="space-y-1.5">
                      {health.signals.map((s, i) => (
                        <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                          s.type === "critical" ? "bg-[oklch(0.97_0.04_27)] text-[oklch(0.40_0.18_27)] border border-[oklch(0.88_0.10_27)]" :
                          s.type === "warning" ? "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border border-[oklch(0.88_0.10_75)]" :
                          "bg-[oklch(0.97_0.04_145)] text-[oklch(0.40_0.14_145)] border border-[oklch(0.85_0.10_145)]"
                        }`}>
                          {s.type === "critical" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
                           s.type === "warning" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
                           <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                          {s.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Metrics grid */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Recipients", value: health.metrics.total_recipients.toLocaleString() },
                      { label: "Sent", value: health.metrics.sent.toLocaleString() },
                      { label: "Delivered", value: `${health.metrics.delivery_rate}%` },
                      { label: "Opened", value: `${health.metrics.open_rate}%` },
                      { label: "Clicked", value: `${health.metrics.click_rate}%` },
                      { label: "Bounced", value: `${health.metrics.bounce_rate}%`, warn: health.metrics.bounce_rate > 2 },
                      { label: "Complained", value: `${health.metrics.complaint_rate}%`, warn: health.metrics.complaint_rate > 0.08 },
                    ].map((m) => (
                      <div key={m.label} className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className={`text-lg font-semibold tabular-nums mt-0.5 ${(m as { warn?: boolean }).warn ? "text-[oklch(0.58_0.22_27)]" : ""}`}>{m.value}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No health data available.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Spam check result modal */}
      {spamResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 w-full max-w-md space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Spam Analysis</h2>
              <button onClick={() => setSpamResult(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex items-center gap-4">
              <div className="relative w-16 h-16 shrink-0">
                <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="6" className="text-muted/30" />
                  <circle
                    cx="32" cy="32" r="28" fill="none" strokeWidth="6" strokeLinecap="round"
                    stroke={spamResult.spam_score >= 80 ? "oklch(0.55 0.16 145)" : spamResult.spam_score >= 50 ? "oklch(0.65 0.16 75)" : "oklch(0.58 0.22 27)"}
                    strokeDasharray={`${(spamResult.spam_score / 100) * 175.9} 175.9`}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">{spamResult.spam_score}</span>
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {spamResult.verdict === "likely_inbox" ? "Likely Inbox" : spamResult.verdict === "at_risk" ? "At Risk" : "Likely Spam"}
                </p>
                <p className="text-xs text-muted-foreground">Content spam score</p>
              </div>
            </div>
            {spamResult.flags.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md px-3 py-2 text-xs bg-[oklch(0.97_0.04_145)] text-[oklch(0.40_0.14_145)] border border-[oklch(0.85_0.10_145)]">
                <CheckCircle2 className="h-3.5 w-3.5" /> No spam triggers found
              </div>
            ) : (
              <div className="space-y-1.5">
                {spamResult.flags.map((f, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs border ${
                    f.severity === "high" ? "bg-[oklch(0.97_0.04_27)] text-[oklch(0.40_0.18_27)] border-[oklch(0.88_0.10_27)]" :
                    f.severity === "medium" ? "bg-[oklch(0.97_0.04_75)] text-[oklch(0.50_0.16_75)] border-[oklch(0.88_0.10_75)]" :
                    "bg-muted text-muted-foreground border-border"
                  }`}>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span><span className="font-medium uppercase tracking-wide mr-1">{f.severity}</span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={() => setSpamResult(null)} className="w-full">Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}
