import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  ShieldCheck, ShieldAlert, CheckCircle2, XCircle, Copy, Sparkles, Calculator,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApiKey } from "@/lib/use-api-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/dashboard/tools")({
  head: () => ({ meta: [{ title: "Deliverability Tools — Continuum API" }] }),
  component: ToolsPage,
});

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success("Copied to clipboard"));
}

// ─── Domain Health ─────────────────────────────────────────────────────────

interface DomainCheckResult {
  domain: string;
  score: number;
  grade: "A" | "B" | "C" | "D";
  checks: {
    spf: { valid: boolean; record: string | null };
    dmarc: { valid: boolean; record: string | null };
    dkim: { found: boolean; selectors: string[] };
    blacklist: { clean: boolean; hits: string[] };
    mx: { found: boolean; records: Array<{ exchange: string; priority: number }> };
    ssl: { valid: boolean; daysUntilExpiry: number | null } | null;
  };
  checkedAt: string;
}

interface DkimResult {
  domain: string;
  selector: string;
  found: boolean;
  record: string | null;
  keyType: string | null;
  keyLength: number | null;
  recommendation: string;
}

const GRADE_COLOR: Record<string, string> = {
  A: "text-[oklch(0.55_0.16_145)]",
  B: "text-[oklch(0.55_0.16_145)]",
  C: "text-[oklch(0.65_0.16_75)]",
  D: "text-[oklch(0.58_0.22_27)]",
};

function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm py-1.5">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-[oklch(0.55_0.16_145)] mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-[oklch(0.58_0.22_27)] mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <span>{label}</span>
        {detail && <p className="text-xs text-muted-foreground font-mono break-all mt-0.5">{detail}</p>}
      </div>
    </li>
  );
}

function DomainHealthTab() {
  const { apiKey } = useApiKey();
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DomainCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selector, setSelector] = useState("google");
  const [dkimLoading, setDkimLoading] = useState(false);
  const [dkimResult, setDkimResult] = useState<DkimResult | null>(null);

  const run = async () => {
    if (!domain || !apiKey?.keyRaw) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setDkimResult(null);
    try {
      const data = await api.withKey.get<DomainCheckResult>(
        `/v1/tools/domain-check?domain=${encodeURIComponent(domain)}`,
        apiKey.keyRaw,
      );
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const runDkim = async () => {
    if (!domain || !apiKey?.keyRaw) return;
    setDkimLoading(true);
    try {
      const data = await api.withKey.get<DkimResult>(
        `/v1/tools/dkim?domain=${encodeURIComponent(domain)}&selector=${encodeURIComponent(selector)}`,
        apiKey.keyRaw,
      );
      setDkimResult(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "DKIM lookup failed");
    } finally {
      setDkimLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground mb-3">
          One check: SPF, DMARC, DKIM, MX, SSL, and blacklist status — with a single A–D grade.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="yourdomain.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <Button onClick={run} disabled={loading || !domain || !apiKey}>
            {loading ? "Checking…" : "Check domain"}
          </Button>
        </div>
        {!apiKey && <p className="mt-2 text-xs text-muted-foreground">No API key configured yet.</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-5 flex flex-col items-center justify-center text-center">
            <p className="text-xs text-muted-foreground mb-1">Deliverability grade</p>
            <p className={`text-5xl font-bold tabular-nums ${GRADE_COLOR[result.grade]}`}>{result.grade}</p>
            <p className="mt-2 text-sm text-muted-foreground">{result.score} / 100</p>
          </div>

          <div className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
            <h3 className="text-sm font-medium mb-1">Authentication</h3>
            <ul>
              <CheckRow ok={result.checks.spf.valid} label="SPF record valid" detail={result.checks.spf.record ?? undefined} />
              <CheckRow ok={result.checks.dmarc.valid} label="DMARC policy found" detail={result.checks.dmarc.record ?? undefined} />
              <CheckRow
                ok={result.checks.dkim.found}
                label="DKIM configured"
                detail={result.checks.dkim.selectors.length ? `selectors: ${result.checks.dkim.selectors.join(", ")}` : "check a specific selector below — most providers don't expose a default"}
              />
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-medium mb-1">Blacklist</h3>
            <ul>
              <CheckRow
                ok={result.checks.blacklist.clean}
                label={result.checks.blacklist.clean ? "Not listed on any blacklist" : "Listed on a blacklist"}
                detail={result.checks.blacklist.hits.length ? result.checks.blacklist.hits.join(", ") : undefined}
              />
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-medium mb-1">MX</h3>
            <ul>
              <CheckRow
                ok={result.checks.mx.found}
                label={result.checks.mx.found ? `${result.checks.mx.records.length} record(s)` : "No MX records"}
                detail={result.checks.mx.records.map((r) => `${r.priority} ${r.exchange}`).join("\n") || undefined}
              />
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="text-sm font-medium mb-1">SSL (port 443)</h3>
            <ul>
              {result.checks.ssl ? (
                <CheckRow
                  ok={result.checks.ssl.valid}
                  label={result.checks.ssl.valid ? "Valid certificate" : "Invalid or unreachable"}
                  detail={result.checks.ssl.daysUntilExpiry != null ? `expires in ${result.checks.ssl.daysUntilExpiry} days` : undefined}
                />
              ) : (
                <CheckRow ok={false} label="Could not connect on port 443" />
              )}
            </ul>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-medium mb-1">DKIM selector lookup</h3>
        <p className="text-xs text-muted-foreground mb-3">
          DKIM keys live at a provider-specific selector (e.g. <code>google</code>, <code>selector1</code>, <code>k1</code>, <code>mandrill</code>). Check by name.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input placeholder="selector (e.g. google)" value={selector} onChange={(e) => setSelector(e.target.value)} className="sm:max-w-[200px]" />
          <Button variant="outline" onClick={runDkim} disabled={dkimLoading || !domain || !apiKey}>
            {dkimLoading ? "Looking up…" : "Check selector"}
          </Button>
        </div>
        {dkimResult && (
          <div className="mt-3 text-sm">
            {dkimResult.found ? (
              <div className="space-y-1">
                <p className="text-[oklch(0.55_0.16_145)] flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Found — {dkimResult.keyType} {dkimResult.keyLength ? `${dkimResult.keyLength}-bit` : ""}</p>
                <p className="text-xs text-muted-foreground font-mono break-all">{dkimResult.record}</p>
              </div>
            ) : (
              <p className="text-muted-foreground flex items-center gap-1.5"><XCircle className="h-4 w-4" /> {dkimResult.recommendation}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DNS Record Generators ─────────────────────────────────────────────────

function SpfGeneratorCard() {
  const { apiKey } = useApiKey();
  const [includes, setIncludes] = useState("amazonses.com");
  const [policy, setPolicy] = useState<"none" | "softfail" | "fail">("softfail");
  const [record, setRecord] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    if (!apiKey?.keyRaw) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ policy });
      if (includes.trim()) params.set("includes", includes.trim());
      const data = await api.withKey.get<{ record: string }>(`/v1/tools/spf-generator?${params}`, apiKey.keyRaw);
      setRecord(data.record);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-medium mb-1">SPF record generator</h3>
      <p className="text-xs text-muted-foreground mb-3">Comma-separated senders to authorize (e.g. your ESPs).</p>
      <div className="space-y-2">
        <Input placeholder="amazonses.com, sendgrid.net" value={includes} onChange={(e) => setIncludes(e.target.value)} />
        <div className="flex gap-2 items-center">
          <Select value={policy} onValueChange={(v) => setPolicy(v as typeof policy)}>
            <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">Strict (-all)</SelectItem>
              <SelectItem value="softfail">Soft fail (~all) — recommended</SelectItem>
              <SelectItem value="none">Neutral (?all)</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={generate} disabled={loading || !apiKey}>{loading ? "Generating…" : "Generate"}</Button>
        </div>
      </div>
      {record && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-muted p-3">
          <code className="text-xs font-mono flex-1 break-all">{record}</code>
          <button onClick={() => copy(record)} className="text-muted-foreground hover:text-foreground shrink-0">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function DmarcGeneratorCard() {
  const { apiKey } = useApiKey();
  const [policy, setPolicy] = useState<"none" | "quarantine" | "reject">("none");
  const [rua, setRua] = useState("");
  const [record, setRecord] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    if (!apiKey?.keyRaw) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ policy });
      if (rua.trim()) params.set("rua", rua.trim());
      const data = await api.withKey.get<{ record: string }>(`/v1/tools/dmarc-generator?${params}`, apiKey.keyRaw);
      setRecord(data.record);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-medium mb-1">DMARC record generator</h3>
      <p className="text-xs text-muted-foreground mb-3">Start at "none" to monitor, then move to quarantine/reject.</p>
      <div className="space-y-2">
        <Input placeholder="reports@yourdomain.com (optional)" value={rua} onChange={(e) => setRua(e.target.value)} />
        <div className="flex gap-2 items-center">
          <Select value={policy} onValueChange={(v) => setPolicy(v as typeof policy)}>
            <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Monitor only (none)</SelectItem>
              <SelectItem value="quarantine">Quarantine</SelectItem>
              <SelectItem value="reject">Reject — strictest</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={generate} disabled={loading || !apiKey}>{loading ? "Generating…" : "Generate"}</Button>
        </div>
      </div>
      {record && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-muted p-3">
          <code className="text-xs font-mono flex-1 break-all">{record}</code>
          <button onClick={() => copy(record)} className="text-muted-foreground hover:text-foreground shrink-0">
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Add as a TXT record at <code>_dmarc.yourdomain.com</code></p>
    </div>
  );
}

function GeneratorsTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SpfGeneratorCard />
      <DmarcGeneratorCard />
    </div>
  );
}

// ─── Content & Spam ─────────────────────────────────────────────────────────

interface SpamCheckResult {
  score: number;
  flags: string[];
  recommendation: string;
}

function SpamCheckCard() {
  const { apiKey } = useApiKey();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SpamCheckResult | null>(null);

  const run = async () => {
    if (!apiKey?.keyRaw || !subject || !body) return;
    setLoading(true);
    try {
      const data = await api.withKey.post<SpamCheckResult>("/v1/tools/spam-check", { subject, body }, apiKey.keyRaw);
      setResult(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Check failed");
    } finally {
      setLoading(false);
    }
  };

  const riskColor = result ? (result.score === 0 ? "text-[oklch(0.55_0.16_145)]" : result.score < 30 ? "text-[oklch(0.65_0.16_75)]" : "text-[oklch(0.58_0.22_27)]") : "";

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        {result && result.score < 30 ? <ShieldCheck className="h-4 w-4 text-[oklch(0.55_0.16_145)]" /> : <ShieldAlert className="h-4 w-4 text-muted-foreground" />}
        <h3 className="text-sm font-medium">Spam content checker</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">Scans subject + body for signals that trigger spam filters, before you send.</p>
      <div className="space-y-2">
        <Input placeholder="Subject line" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea placeholder="Email body (plain text or HTML)" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <Button onClick={run} disabled={loading || !subject || !body || !apiKey}>{loading ? "Scanning…" : "Check content"}</Button>
      </div>
      {result && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm">
            <span>Spam score</span>
            <span className={`font-semibold tabular-nums ${riskColor}`}>{result.score} / 100</span>
          </div>
          <p className={`text-xs mt-1 ${riskColor}`}>{result.recommendation}</p>
          {result.flags.length > 0 && (
            <ul className="mt-3 space-y-1">
              {result.flags.map((f, i) => (
                <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[oklch(0.58_0.22_27)]" />
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SubjectLineCard() {
  const { apiKey } = useApiKey();
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState<"professional" | "casual" | "witty" | "urgent" | "curious">("professional");
  const [loading, setLoading] = useState(false);
  const [subjects, setSubjects] = useState<string[]>([]);

  const run = async () => {
    if (!apiKey?.keyRaw || !topic) return;
    setLoading(true);
    try {
      const data = await api.withKey.post<{ subjects: string[] }>(
        "/v1/tools/subject-line",
        { topic, tone, count: 5 },
        apiKey.keyRaw,
      );
      setSubjects(data.subjects);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">AI subject line generator</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">Describe what the email is about — get spam-safe subject lines.</p>
      <div className="space-y-2">
        <Input placeholder="e.g. Black Friday 20% off sitewide, ends Sunday" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <div className="flex gap-2 items-center">
          <Select value={tone} onValueChange={(v) => setTone(v as typeof tone)}>
            <SelectTrigger className="max-w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="professional">Professional</SelectItem>
              <SelectItem value="casual">Casual</SelectItem>
              <SelectItem value="witty">Witty</SelectItem>
              <SelectItem value="urgent">Urgent</SelectItem>
              <SelectItem value="curious">Curious</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={run} disabled={loading || !topic || !apiKey}>{loading ? "Generating…" : "Generate"}</Button>
        </div>
      </div>
      {subjects.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {subjects.map((s, i) => (
            <li key={i} className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <span className="flex-1">{s}</span>
              <button onClick={() => copy(s)} className="text-muted-foreground hover:text-foreground shrink-0">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContentTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <SpamCheckCard />
      <SubjectLineCard />
    </div>
  );
}

// ─── Rate Calculator ────────────────────────────────────────────────────────

interface RatesResult {
  rates: Record<string, number>;
  benchmarks: Record<string, { good: string; average: string; poor: string }>;
}

const RATE_LABELS: Record<string, string> = {
  delivery_rate: "Delivery rate",
  open_rate: "Open rate",
  click_rate: "Click rate",
  cto_rate: "Click-to-open rate",
  bounce_rate: "Bounce rate",
  complaint_rate: "Complaint rate",
  unsubscribe_rate: "Unsubscribe rate",
};

function RatesTab() {
  const { apiKey } = useApiKey();
  const [inputs, setInputs] = useState({ sent: "", delivered: "", opened: "", clicked: "", bounced: "", complained: "", unsubscribed: "" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RatesResult | null>(null);

  const setField = (k: keyof typeof inputs) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((prev) => ({ ...prev, [k]: e.target.value.replace(/[^0-9]/g, "") }));

  const run = async () => {
    if (!apiKey?.keyRaw || !inputs.sent) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(inputs)) if (v) params.set(k, v);
      const data = await api.withKey.get<RatesResult>(`/v1/tools/rates?${params}`, apiKey.keyRaw);
      setResult(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Calculation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Calculator className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Campaign metrics calculator</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">Plug in raw counts, get every rate that matters — with benchmarks.</p>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Sent *" value={inputs.sent} onChange={setField("sent")} />
          <Input placeholder="Delivered" value={inputs.delivered} onChange={setField("delivered")} />
          <Input placeholder="Opened" value={inputs.opened} onChange={setField("opened")} />
          <Input placeholder="Clicked" value={inputs.clicked} onChange={setField("clicked")} />
          <Input placeholder="Bounced" value={inputs.bounced} onChange={setField("bounced")} />
          <Input placeholder="Complained" value={inputs.complained} onChange={setField("complained")} />
          <Input placeholder="Unsubscribed" value={inputs.unsubscribed} onChange={setField("unsubscribed")} />
        </div>
        <Button className="mt-3" onClick={run} disabled={loading || !inputs.sent || !apiKey}>{loading ? "Calculating…" : "Calculate"}</Button>
      </div>

      {result && (
        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3 border-b border-border">
            <h3 className="text-sm font-medium">Results</h3>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(result.rates).map(([k, v]) => (
                <tr key={k} className="border-b border-border last:border-0">
                  <td className="px-5 py-2.5">{RATE_LABELS[k] ?? k}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums font-medium">{v}%</td>
                  <td className="px-5 py-2.5 text-right text-xs text-muted-foreground">
                    {result.benchmarks[k] ? `good ${result.benchmarks[k].good}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────

function ToolsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Deliverability Tools</h1>
        <p className="text-sm text-muted-foreground">
          The free deliverability toolkit no standalone verifier bundles in — domain health, DNS record generators, spam scoring, and campaign math, all against your own API key.
        </p>
      </header>

      <Tabs defaultValue="domain">
        <TabsList>
          <TabsTrigger value="domain">Domain Health</TabsTrigger>
          <TabsTrigger value="generators">DNS Generators</TabsTrigger>
          <TabsTrigger value="content">Content & Spam</TabsTrigger>
          <TabsTrigger value="rates">Rate Calculator</TabsTrigger>
        </TabsList>
        <TabsContent value="domain" className="mt-4">
          <DomainHealthTab />
        </TabsContent>
        <TabsContent value="generators" className="mt-4">
          <GeneratorsTab />
        </TabsContent>
        <TabsContent value="content" className="mt-4">
          <ContentTab />
        </TabsContent>
        <TabsContent value="rates" className="mt-4">
          <RatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
