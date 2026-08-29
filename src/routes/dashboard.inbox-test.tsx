import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, CheckCircle2, XCircle, HelpCircle, Loader2, FlaskConical } from "lucide-react";

export const Route = createFileRoute("/dashboard/inbox-test")({
  head: () => ({ meta: [{ title: "Inbox Placement — Continuum API" }] }),
  component: InboxTestPage,
});

interface PlacementResult {
  gmail?: string;
  outlook?: string;
  yahoo?: string;
}

interface InboxTest {
  id: string;
  subject: string;
  fromEmail: string;
  status: string;
  results?: PlacementResult;
  score?: number;
  createdAt: string;
  checkedAt?: string;
}

const PROVIDER_LABELS: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", yahoo: "Yahoo" };
const PLACEMENT_LABEL: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  inbox: { label: "Inbox", color: "text-green-600", icon: CheckCircle2 },
  promotions: { label: "Promotions", color: "text-muted-foreground", icon: HelpCircle },
  spam: { label: "Spam", color: "text-red-600", icon: XCircle },
  unknown: { label: "Unknown", color: "text-muted-foreground", icon: HelpCircle },
};

function InboxTestPage() {
  const { primaryKey } = useAuth();
  const [tests, setTests] = useState<InboxTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState({ fromName: "", fromEmail: "", subject: "", htmlBody: "" });

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: InboxTest[] }>("/v1/inbox-tests?page=1&limit=20", primaryKey.keyRaw)
      .then((r) => setTests(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const runTest = async () => {
    if (!primaryKey?.keyRaw) return;
    if (!form.fromName || !form.fromEmail || !form.subject || !form.htmlBody) {
      toast.error("Fill in all fields");
      return;
    }
    setRunning(true);
    try {
      await api.withKey.post("/v1/inbox-test", {
        from_name: form.fromName,
        from_email: form.fromEmail,
        subject: form.subject,
        html_body: form.htmlBody,
      }, primaryKey.keyRaw);
      toast.success("Test running — results available in ~2 minutes. Refresh to check.");
      load();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Inbox Placement Testing</h1>
        <p className="text-sm text-muted-foreground">Check if your email lands in inbox, promotions, or spam across providers.</p>
      </header>

      {/* Run test form */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-2xl">
        <h2 className="text-sm font-semibold flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Run Placement Test</h2>
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
        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input placeholder="Your May update" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
        </div>
        <div className="space-y-1.5">
          <Label>HTML body</Label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[80px] resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="<p>Hi,</p><p>Here's your update…</p>"
            value={form.htmlBody}
            onChange={(e) => setForm((f) => ({ ...f, htmlBody: e.target.value }))}
          />
        </div>
        <Button onClick={runTest} disabled={running} className="gap-1.5">
          {running ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending test…</> : <><FlaskConical className="h-4 w-4" /> Run Test</>}
        </Button>
      </div>

      {/* Test history */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Recent Tests</h2>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : tests.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <Mail className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No tests run yet. Run your first inbox placement test above.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-medium">Subject</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Gmail</th>
                  <th className="px-5 py-3 font-medium">Outlook</th>
                  <th className="px-5 py-3 font-medium">Yahoo</th>
                  <th className="px-5 py-3 font-medium">Score</th>
                  <th className="px-5 py-3 font-medium">Run at</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-5 py-3">
                      <div className="font-medium truncate max-w-[200px]">{t.subject}</div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px]">{t.fromEmail}</div>
                    </td>
                    <td className="px-5 py-3">
                      {t.status === "pending" || t.status === "checking"
                        ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking…</span>
                        : <span className="text-xs text-green-600 capitalize">{t.status}</span>
                      }
                    </td>
                    {(["gmail", "outlook", "yahoo"] as const).map((provider) => {
                      const placement = t.results?.[provider] ?? (t.status === "complete" ? "unknown" : null);
                      if (!placement) return <td key={provider} className="px-5 py-3 text-xs text-muted-foreground">—</td>;
                      const info = PLACEMENT_LABEL[placement] ?? PLACEMENT_LABEL["unknown"]!;
                      const Icon = info.icon;
                      return (
                        <td key={provider} className="px-5 py-3">
                          <span className={`flex items-center gap-1 text-xs ${info.color}`}>
                            <Icon className="h-3.5 w-3.5" /> {info.label}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-5 py-3">
                      {t.score != null
                        ? <span className={`text-sm font-semibold tabular-nums ${t.score >= 80 ? "text-foreground" : t.score >= 50 ? "text-muted-foreground" : "text-destructive"}`}>{t.score}/100</span>
                        : <span className="text-muted-foreground text-xs">—</span>
                      }
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
