import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sparkles, Copy, Download, ChevronDown } from "lucide-react";

export const Route = createFileRoute("/dashboard/ai")({
  head: () => ({ meta: [{ title: "AI Tools — Continuum" }] }),
  component: AiPage,
});

type AiTab = "personalize" | "generate" | "esp";

interface PersonalizeResult {
  email: string;
  first_line: string | null;
  error: string | null;
}

interface PersonalizeResponse {
  results: PersonalizeResult[];
  model: string;
  usage: { leads_processed: number; successful: number };
}

interface EmailVariant {
  subject: string;
  body?: string;
}

interface GenerateResponse {
  variants: EmailVariant[];
  model: string;
  usage: { variants_generated: number };
}

interface EspResult { email: string; esp: string | null; }

function parseLead(line: string) {
  const parts = line.split(",").map((p) => p.trim());
  return {
    email: parts[0] ?? "",
    first_name: parts[1] || undefined,
    company: parts[2] || undefined,
    title: parts[3] || undefined,
    company_description: parts[4] || undefined,
  };
}

function AiPage() {
  const { primaryKey } = useAuth();
  const [tab, setTab] = useState<AiTab>("personalize");

  // Personalize state
  const [leads, setLeads] = useState("");
  const [tone, setTone] = useState<"professional" | "casual" | "witty">("professional");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [showTemplate, setShowTemplate] = useState(false);
  const [personalizing, setPersonalizing] = useState(false);
  const [personalizeResults, setPersonalizeResults] = useState<PersonalizeResult[] | null>(null);
  const [personalizeUsage, setPersonalizeUsage] = useState<{ leads_processed: number; successful: number } | null>(null);

  // Generate state
  const [genType, setGenType] = useState("cold_outreach");
  const [genAbout, setGenAbout] = useState("");
  const [genTone, setGenTone] = useState<"professional" | "casual" | "friendly" | "urgent">("professional");
  const [numVariants, setNumVariants] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [variants, setVariants] = useState<EmailVariant[] | null>(null);

  // ESP detector state
  const [espEmails, setEspEmails] = useState("");
  const [espLoading, setEspLoading] = useState(false);
  const [espResults, setEspResults] = useState<EspResult[] | null>(null);

  const parsedLeads = leads
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("@"))
    .map(parseLead)
    .filter((l) => l.email.includes("@") && l.email.includes("."));

  const personalize = async () => {
    if (!primaryKey?.keyRaw) return;
    if (parsedLeads.length === 0) { toast.error("Add at least one valid lead email"); return; }
    if (parsedLeads.length > 100) { toast.error("Maximum 100 leads per request"); return; }
    setPersonalizing(true);
    setPersonalizeResults(null);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/ai/personalize", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({
          leads: parsedLeads,
          tone,
          ...(promptTemplate.trim() ? { prompt_template: promptTemplate.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as PersonalizeResponse | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      const typed = data as PersonalizeResponse;
      setPersonalizeResults(typed.results ?? []);
      setPersonalizeUsage(typed.usage ?? null);
      toast.success(`Generated ${typed.usage?.successful ?? 0} first lines`);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setPersonalizing(false); }
  };

  const copyLine = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
  };

  const exportCsv = () => {
    if (!personalizeResults) return;
    const rows = [
      "email,first_line",
      ...personalizeResults.map((r) => `"${r.email}","${(r.first_line ?? "").replace(/"/g, '""')}"`),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "first_lines.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const generate = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!genAbout.trim()) { toast.error("Describe what the email is about"); return; }
    setGenerating(true);
    setVariants(null);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/ai/generate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ type: genType, about: genAbout, tone: genTone, num_variants: numVariants }),
      });
      const data = await res.json().catch(() => null) as GenerateResponse | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      const typed = data as GenerateResponse;
      setVariants(typed.variants ?? []);
      toast.success(`Generated ${typed.variants?.length ?? 0} variant${typed.variants?.length !== 1 ? "s" : ""}`);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setGenerating(false); }
  };

  const parsedEspEmails = espEmails
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l.includes("@") && l.includes("."));

  const detectEsp = async () => {
    if (!primaryKey?.keyRaw) return;
    if (parsedEspEmails.length === 0) { toast.error("Add at least one email address"); return; }
    if (parsedEspEmails.length > 100) { toast.error("Maximum 100 emails per request"); return; }
    setEspLoading(true);
    setEspResults(null);
    try {
      const res = await fetch("https://api.continuumapi.com/v1/ai/detect-esp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": primaryKey.keyRaw! },
        body: JSON.stringify({ emails: parsedEspEmails }),
      });
      const data = await res.json().catch(() => null) as { results?: EspResult[] } | { error?: string };
      if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
      setEspResults((data as { results?: EspResult[] }).results ?? []);
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setEspLoading(false); }
  };

  const espLabel = (esp: string | null) => {
    const map: Record<string, string> = { google: "Google / Gmail", microsoft: "Microsoft / Outlook", yahoo: "Yahoo / AOL", other: "Other / self-hosted" };
    return esp ? (map[esp] ?? esp) : "Unknown";
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight flex items-center gap-2">
          <Sparkles className="h-5 w-5" /> AI Tools
        </h1>
        <p className="text-sm text-muted-foreground">AI-powered personalization and email generation. Requires Growth plan or higher.</p>
      </header>

      <div className="flex gap-1 border-b border-border">
        {([["personalize", "First Line Generator"], ["generate", "Email Generator"], ["esp", "ESP Detector"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "personalize" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-5 rounded-lg border border-border bg-card p-6">
            <div className="space-y-1.5">
              <Label>Leads <span className="text-muted-foreground font-normal text-xs">(email, first_name, company, title — one per line)</span></Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[160px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={"alice@acme.com, Alice, Acme Inc, VP Sales\nbob@startup.io, Bob, Startup.io, CTO\ncarla@corp.com, Carla, Corp, Head of Growth"}
                value={leads}
                onChange={(e) => setLeads(e.target.value)}
              />
              {parsedLeads.length > 0 && (
                <p className="text-xs text-muted-foreground">{parsedLeads.length} lead{parsedLeads.length !== 1 ? "s" : ""} parsed
                  {parsedLeads.length > 100 && <span className="text-destructive font-medium"> — max 100</span>}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Tone</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={tone}
                onChange={(e) => setTone(e.target.value as typeof tone)}
              >
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="witty">Witty</option>
              </select>
            </div>

            <div>
              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2"
                onClick={() => setShowTemplate((s) => !s)}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showTemplate ? "rotate-180" : ""}`} />
                Custom prompt template (optional)
              </button>
              {showTemplate && (
                <textarea
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="You write personalized cold email opening lines. Write ONE sentence only. Be specific to the person's role and company."
                  value={promptTemplate}
                  onChange={(e) => setPromptTemplate(e.target.value)}
                />
              )}
            </div>

            <Button onClick={personalize} disabled={personalizing || parsedLeads.length === 0 || parsedLeads.length > 100} className="w-full gap-1.5">
              <Sparkles className="h-4 w-4" />
              {personalizing ? `Generating for ${parsedLeads.length}…` : `Generate ${parsedLeads.length || "—"} first line${parsedLeads.length !== 1 ? "s" : ""}`}
            </Button>
          </div>

          <div className="space-y-4">
            {personalizeUsage && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{personalizeUsage.successful} / {personalizeUsage.leads_processed} succeeded</span>
                {personalizeResults && personalizeResults.length > 0 && (
                  <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" onClick={exportCsv}>
                    <Download className="h-3.5 w-3.5" /> Export CSV
                  </Button>
                )}
              </div>
            )}
            {personalizeResults ? (
              personalizeResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">No results returned.</p>
              ) : (
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                        <th className="px-4 py-2 font-medium">Lead</th>
                        <th className="px-4 py-2 font-medium">First line</th>
                        <th className="px-4 py-2 font-medium w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {personalizeResults.map((r, i) => (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap max-w-[140px] truncate">{r.email}</td>
                          <td className="px-4 py-2.5 text-xs">
                            {r.error ? (
                              <span className="text-destructive">{r.error}</span>
                            ) : (
                              <span>{r.first_line ?? "—"}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {r.first_line && (
                              <button onClick={() => copyLine(r.first_line!)} className="text-muted-foreground hover:text-foreground">
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">Generated first lines appear here.</p>
                <p className="text-xs text-muted-foreground mt-1">Each lead gets a unique, personalized opening based on their company and role.</p>
              </div>
            )}
          </div>
        </div>
      ) : tab === "generate" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-5 rounded-lg border border-border bg-card p-6">
            <div className="space-y-1.5">
              <Label>Email type</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={genType}
                onChange={(e) => setGenType(e.target.value)}
              >
                <option value="cold_outreach">Cold outreach</option>
                <option value="follow_up">Follow-up</option>
                <option value="newsletter">Newsletter</option>
                <option value="transactional">Transactional</option>
                <option value="re_engagement">Re-engagement</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>What is this email about? *</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[100px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="We're a B2B SaaS that helps sales teams automate their outbound email sequences. This email introduces our product to VPs of Sales at mid-market companies."
                value={genAbout}
                onChange={(e) => setGenAbout(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={genTone}
                  onChange={(e) => setGenTone(e.target.value as typeof genTone)}
                >
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="friendly">Friendly</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Variants</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={numVariants}
                  onChange={(e) => setNumVariants(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n} variant{n !== 1 ? "s" : ""}</option>
                  ))}
                </select>
              </div>
            </div>

            <Button onClick={generate} disabled={generating || !genAbout.trim()} className="w-full gap-1.5">
              <Sparkles className="h-4 w-4" />
              {generating ? "Generating…" : `Generate ${numVariants} variant${numVariants !== 1 ? "s" : ""}`}
            </Button>
          </div>

          <div className="space-y-4">
            {variants ? (
              variants.length === 0 ? (
                <p className="text-sm text-muted-foreground">No variants returned.</p>
              ) : (
                <div className="space-y-4">
                  {variants.map((v, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Variant {String.fromCharCode(65 + i)}
                        </span>
                        <button
                          onClick={() => copyLine(`Subject: ${v.subject}\n\n${v.body ?? ""}`)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground mb-0.5">Subject</p>
                        <p className="text-sm font-medium">{v.subject}</p>
                      </div>
                      {v.body && (
                        <div>
                          <p className="text-xs text-muted-foreground mb-0.5">Body</p>
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{v.body}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">Email variants appear here.</p>
                <p className="text-xs text-muted-foreground mt-1">Use as A/B test starting points in your sequences.</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-5 rounded-lg border border-border bg-card p-6">
            <div className="space-y-1.5">
              <Label>Email addresses <span className="text-muted-foreground font-normal text-xs">(one per line or comma-separated)</span></Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[160px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={"alice@gmail.com\nbob@company-domain.com\ncarla@yahoo.com"}
                value={espEmails}
                onChange={(e) => setEspEmails(e.target.value)}
              />
              {parsedEspEmails.length > 0 && (
                <p className="text-xs text-muted-foreground">{parsedEspEmails.length} email{parsedEspEmails.length !== 1 ? "s" : ""} parsed
                  {parsedEspEmails.length > 100 && <span className="text-destructive font-medium"> — max 100</span>}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Knowing whether a recipient is on Gmail, Outlook, Yahoo, or a self-hosted domain lets you throttle sends and warmup pacing per-ISP instead of treating every inbox the same.
            </p>
            <Button onClick={detectEsp} disabled={espLoading || parsedEspEmails.length === 0} className="w-full gap-1.5">
              <Sparkles className="h-4 w-4" />
              {espLoading ? "Detecting…" : `Detect ${parsedEspEmails.length || ""} provider${parsedEspEmails.length !== 1 ? "s" : ""}`}
            </Button>
          </div>

          <div>
            {espResults ? (
              espResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">No results.</p>
              ) : (
                <div className="rounded-lg border border-border bg-card">
                  <table className="w-full text-sm">
                    <tbody>
                      {espResults.map((r, i) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="px-4 py-2.5 font-mono text-xs">{r.email}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">{espLabel(r.esp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <div className="rounded-lg border border-dashed border-border p-8 text-center">
                <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">Provider results appear here.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
