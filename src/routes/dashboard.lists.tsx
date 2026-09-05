import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Users, Trash2, Leaf, X, ChevronDown, AlertTriangle, CheckCircle2, Clock, Ban, Upload, FileText, ArrowRight, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/dashboard/lists")({
  head: () => ({ meta: [{ title: "Mailing Lists — Continuum API" }] }),
  component: ListsPage,
});

interface MailingList { id: string; name: string; description: string | null; contactCount: number; createdAt: string; }

type HygieneBucket = "active" | "at_risk" | "inactive" | "never_opened";

interface HygieneContact {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  lastEngagedAt: string | null;
  bucket: HygieneBucket;
}

interface HygieneReport {
  total: number;
  active: number;
  at_risk: number;
  inactive: number;
  never_opened: number;
  inactive_days: number;
  contacts: HygieneContact[];
}

const BUCKET_META: Record<HygieneBucket, { label: string; color: string; icon: React.ReactNode; description: string }> = {
  active:       { label: "Active",       color: "text-[oklch(0.55_0.16_145)]", icon: <CheckCircle2 className="h-4 w-4" />, description: "Engaged in selected window" },
  at_risk:      { label: "At risk",      color: "text-[oklch(0.65_0.16_75)]",  icon: <Clock className="h-4 w-4" />,         description: "No engagement in 1–2× window" },
  inactive:     { label: "Inactive",     color: "text-[oklch(0.58_0.22_27)]",  icon: <AlertTriangle className="h-4 w-4" />, description: "No engagement in 2× window" },
  never_opened: { label: "Never opened", color: "text-muted-foreground",        icon: <Ban className="h-4 w-4" />,           description: "Never opened any email" },
};

function ListHygieneModal({
  list,
  apiKey,
  onClose,
}: {
  list: MailingList;
  apiKey: string;
  onClose: () => void;
}) {
  const [inactiveDays, setInactiveDays] = useState(90);
  const [report, setReport] = useState<HygieneReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [suppressing, setSuppressing] = useState(false);
  const [bucketFilter, setBucketFilter] = useState<HygieneBucket | "all">("all");
  const [showContacts, setShowContacts] = useState(false);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `https://api.continuumapi.com/v1/lists/${list.id}/hygiene?inactive_days=${inactiveDays}`,
        { headers: { "X-API-Key": apiKey } },
      );
      const data = await res.json() as HygieneReport;
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed");
      setReport(data);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [list.id, apiKey, inactiveDays]);

  const suppress = async (buckets: HygieneBucket[]) => {
    if (!confirm(`Suppress ${buckets.join(" + ")} contacts from "${list.name}"?\nThey will be unsubscribed from this list and added to the global suppression list.`)) return;
    setSuppressing(true);
    try {
      const res = await fetch(`https://api.continuumapi.com/v1/lists/${list.id}/hygiene/suppress`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ inactive_days: inactiveDays, buckets }),
      });
      const data = await res.json() as { suppressed: number; message: string };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed");
      toast.success(data.message);
      setReport(null);
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setSuppressing(false);
    }
  };

  const filteredContacts = report?.contacts.filter((c) => bucketFilter === "all" || c.bucket === bucketFilter) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="rounded-lg border border-border bg-card w-full max-w-2xl shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Leaf className="h-4 w-4 text-[oklch(0.55_0.16_145)]" /> List Hygiene
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{list.name} · {list.contactCount.toLocaleString()} subscribers</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Controls */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs">Engagement window (days)</Label>
              <select
                value={inactiveDays}
                onChange={(e) => { setInactiveDays(Number(e.target.value)); setReport(null); }}
                className="h-8 text-sm rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {[30, 60, 90, 120, 180, 365].map((d) => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
            </div>
            <Button size="sm" onClick={() => void runAnalysis()} disabled={loading}>
              {loading ? "Analyzing…" : report ? "Re-run analysis" : "Run analysis"}
            </Button>
          </div>

          {report && (
            <>
              {/* Bucket summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(["active", "at_risk", "inactive", "never_opened"] as HygieneBucket[]).map((b) => {
                  const meta = BUCKET_META[b];
                  const count = report[b as keyof HygieneReport] as number;
                  const pct = report.total > 0 ? Math.round((count / report.total) * 100) : 0;
                  return (
                    <button
                      key={b}
                      onClick={() => { setBucketFilter(bucketFilter === b ? "all" : b); setShowContacts(true); }}
                      className={`rounded-lg border p-3 text-left space-y-1 transition-colors hover:bg-muted/40 ${bucketFilter === b ? "border-foreground/30 bg-muted/30" : "border-border"}`}
                    >
                      <div className={`flex items-center gap-1.5 text-xs font-medium ${meta.color}`}>
                        {meta.icon} {meta.label}
                      </div>
                      <div className="text-2xl font-mono font-semibold tabular-nums">{count.toLocaleString()}</div>
                      <div className="text-[10px] text-muted-foreground">{pct}% of list</div>
                    </button>
                  );
                })}
              </div>

              {/* Suppress actions */}
              {(report.inactive > 0 || report.never_opened > 0) && (
                <div className="rounded-lg border border-[oklch(0.65_0.16_75)]/30 bg-[oklch(0.65_0.16_75)]/5 p-4 space-y-3">
                  <p className="text-sm font-medium">Clean your list</p>
                  <div className="flex flex-wrap gap-2">
                    {report.inactive > 0 && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => void suppress(["inactive"])}
                        disabled={suppressing}
                        className="text-xs h-7"
                      >
                        <Ban className="h-3 w-3 mr-1.5" />
                        Suppress {report.inactive.toLocaleString()} inactive
                      </Button>
                    )}
                    {report.never_opened > 0 && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => void suppress(["never_opened"])}
                        disabled={suppressing}
                        className="text-xs h-7"
                      >
                        <Ban className="h-3 w-3 mr-1.5" />
                        Suppress {report.never_opened.toLocaleString()} never-opened
                      </Button>
                    )}
                    {(report.inactive > 0 || report.never_opened > 0) && (
                      <Button
                        size="sm" variant="outline"
                        onClick={() => void suppress(["inactive", "never_opened"])}
                        disabled={suppressing}
                        className="text-xs h-7"
                      >
                        Suppress all unengaged ({(report.inactive + report.never_opened).toLocaleString()})
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Contact list */}
              <div>
                <button
                  onClick={() => setShowContacts((v) => !v)}
                  className="flex items-center gap-2 text-xs font-medium hover:text-foreground text-muted-foreground transition-colors w-full"
                >
                  {showContacts ? <ChevronDown className="h-3.5 w-3.5 rotate-180" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {bucketFilter === "all" ? "All contacts" : `${BUCKET_META[bucketFilter].label} contacts`} ({filteredContacts.length.toLocaleString()})
                </button>

                {showContacts && filteredContacts.length > 0 && (
                  <div className="mt-2 rounded-md border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Email</th>
                          <th className="px-3 py-2 text-left font-medium">Status</th>
                          <th className="px-3 py-2 text-left font-medium">Last engaged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredContacts.slice(0, 50).map((c) => {
                          const meta = BUCKET_META[c.bucket];
                          return (
                            <tr key={c.id} className="border-t border-border hover:bg-muted/20">
                              <td className="px-3 py-2 font-mono">{c.email}</td>
                              <td className={`px-3 py-2 ${meta.color} flex items-center gap-1`}>
                                {meta.icon} {meta.label}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {c.lastEngagedAt ? new Date(c.lastEngagedAt).toLocaleDateString() : "Never"}
                              </td>
                            </tr>
                          );
                        })}
                        {filteredContacts.length > 50 && (
                          <tr className="border-t border-border">
                            <td colSpan={3} className="px-3 py-2 text-center text-muted-foreground">
                              +{(filteredContacts.length - 50).toLocaleString()} more — suppress to remove all at once
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface PreflightReport {
  total: number;
  breakdown: { likely_deliverable: number; risky: number; likely_bounce: number; suppressed: number; unknown: number };
  suppressed_reasons: Record<string, number>;
  sample_risky: string[];
}

const PREFLIGHT_META: Record<keyof PreflightReport["breakdown"], { label: string; color: string; icon: React.ReactNode }> = {
  likely_deliverable: { label: "Likely to deliver", color: "text-[oklch(0.55_0.16_145)]", icon: <CheckCircle2 className="h-4 w-4" /> },
  risky:               { label: "Risky (can't confirm)", color: "text-[oklch(0.65_0.16_75)]", icon: <AlertTriangle className="h-4 w-4" /> },
  likely_bounce:       { label: "Likely to bounce", color: "text-[oklch(0.58_0.22_27)]", icon: <Ban className="h-4 w-4" /> },
  suppressed:          { label: "Already suppressed", color: "text-[oklch(0.58_0.22_27)]", icon: <Ban className="h-4 w-4" /> },
  unknown:             { label: "Not yet checked", color: "text-muted-foreground", icon: <Clock className="h-4 w-4" /> },
};

function PreflightModal({ list, apiKey, onClose }: { list: MailingList; apiKey: string; onClose: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.withKey.post<PreflightReport>("/v1/preflight", { list_id: list.id }, apiKey)
      .then(setReport)
      .catch((e: unknown) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
    // Runs once per open — this reads existing data, it doesn't spend any
    // verification credits, but there's still no reason to refire it every
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="rounded-lg border border-border bg-card w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Deliverability Check
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{list.name} · {list.contactCount.toLocaleString()} subscribers</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Checking against our verification cache and suppression list…</p>
          ) : !report ? (
            <p className="text-sm text-muted-foreground">Couldn't load a report.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Based on what we already know for this list — no new verification credits spent. Addresses we've never checked show as "not yet checked," not guessed at.
              </p>
              <div className="grid grid-cols-2 gap-3">
                {(Object.keys(PREFLIGHT_META) as Array<keyof PreflightReport["breakdown"]>).map((key) => {
                  const meta = PREFLIGHT_META[key];
                  const count = report.breakdown[key];
                  const pct = report.total > 0 ? Math.round((count / report.total) * 100) : 0;
                  return (
                    <div key={key} className="rounded-lg border border-border p-3 space-y-1">
                      <div className={`flex items-center gap-1.5 text-xs font-medium ${meta.color}`}>{meta.icon} {meta.label}</div>
                      <div className="text-2xl font-mono font-semibold tabular-nums">{count.toLocaleString()}</div>
                      <div className="text-[10px] text-muted-foreground">{pct}% of list</div>
                    </div>
                  );
                })}
              </div>

              {Object.keys(report.suppressed_reasons).length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Suppressed: {Object.entries(report.suppressed_reasons).map(([reason, count]) => `${count} ${reason.replace(/_/g, " ")}`).join(", ")}
                </div>
              )}

              {report.sample_risky.length > 0 && (
                <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Flagged addresses (sample)</p>
                  <div className="text-xs font-mono space-y-0.5 max-h-32 overflow-y-auto">
                    {report.sample_risky.map((email) => <div key={email}>{email}</div>)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

function parseCsvToRows(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? "").trim()]));
  });
}

function detectEmailCol(headers: string[]): string | null {
  const candidates = ["email", "email_address", "e-mail", "emailaddress", "mail"];
  return headers.find((h) => candidates.includes(h.toLowerCase())) ?? null;
}

function CsvImportModal({ list, apiKey, onClose, onDone }: { list: MailingList; apiKey: string; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [emailCol, setEmailCol] = useState<string>("");
  const [firstNameCol, setFirstNameCol] = useState<string>("");
  const [lastNameCol, setLastNameCol] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCsvToRows(text);
      setRows(parsed);
      const headers = Object.keys(parsed[0] ?? {});
      const detectedEmail = detectEmailCol(headers) ?? "";
      setEmailCol(detectedEmail);
      setFirstNameCol(headers.find((h) => h.includes("first")) ?? "");
      setLastNameCol(headers.find((h) => h.includes("last")) ?? "");
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!emailCol || rows.length === 0) return;
    setImporting(true);
    setDone(false);
    setProgress({ done: 0, total: rows.length, failed: 0 });
    const BATCH = 20;
    let done_count = 0, failed_count = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (row) => {
        try {
          const email = row[emailCol]?.trim();
          if (!email || !email.includes("@")) { failed_count++; return; }
          const body: Record<string, string | undefined> = { email };
          if (firstNameCol && row[firstNameCol]) body.first_name = row[firstNameCol];
          if (lastNameCol && row[lastNameCol]) body.last_name = row[lastNameCol];
          const res = await fetch(`https://api.continuumapi.com/v1/lists/${list.id}/contacts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
            body: JSON.stringify(body),
          });
          if (!res.ok) failed_count++;
          else done_count++;
        } catch { failed_count++; }
      }));
      setProgress({ done: done_count, total: rows.length, failed: failed_count });
    }
    setImporting(false);
    setDone(true);
    onDone();
  };

  const headers = Object.keys(rows[0] ?? {});
  const colOptions = ["", ...headers];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="rounded-lg border border-border bg-card w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" /> Import subscribers
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          {rows.length === 0 ? (
            <div
              className="rounded-lg border-2 border-dashed border-border p-8 text-center cursor-pointer hover:border-foreground/30 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
            >
              <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
              <p className="text-sm text-muted-foreground">Drop your CSV here, or <span className="text-foreground underline underline-offset-2">browse</span></p>
              <p className="text-xs text-muted-foreground mt-1">Any CSV with an email column — field names auto-detected</p>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </div>
          ) : (
            <>
              <div className="rounded-md bg-muted/40 border border-border px-3 py-2 flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium tabular-nums">{rows.length.toLocaleString()}</span>
                <span className="text-muted-foreground">rows detected</span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Email column *</Label>
                  <select className="w-full h-8 rounded-md border border-input bg-background text-sm px-2 focus:outline-none focus:ring-2 focus:ring-ring" value={emailCol} onChange={(e) => setEmailCol(e.target.value)}>
                    {colOptions.map((c) => <option key={c} value={c}>{c || "— pick —"}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">First name (optional)</Label>
                  <select className="w-full h-8 rounded-md border border-input bg-background text-sm px-2 focus:outline-none focus:ring-2 focus:ring-ring" value={firstNameCol} onChange={(e) => setFirstNameCol(e.target.value)}>
                    {colOptions.map((c) => <option key={c} value={c}>{c || "— none —"}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Last name (optional)</Label>
                  <select className="w-full h-8 rounded-md border border-input bg-background text-sm px-2 focus:outline-none focus:ring-2 focus:ring-ring" value={lastNameCol} onChange={(e) => setLastNameCol(e.target.value)}>
                    {colOptions.map((c) => <option key={c} value={c}>{c || "— none —"}</option>)}
                  </select>
                </div>
              </div>

              {/* Preview rows */}
              <div className="rounded-md border border-border overflow-hidden">
                <div className="px-3 py-1.5 bg-muted/30 text-xs font-medium text-muted-foreground">Preview (first 3 rows)</div>
                <table className="w-full text-xs">
                  <thead className="bg-muted/20">
                    <tr>{headers.slice(0, 5).map((h) => <th key={h} className="px-3 py-1.5 text-left font-medium text-muted-foreground">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 3).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {headers.slice(0, 5).map((h) => <td key={h} className="px-3 py-1.5 font-mono truncate max-w-[120px]">{r[h]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {progress && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{done ? "Import complete" : "Importing…"}</span>
                    <span className="tabular-nums font-medium">{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-foreground transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
                  </div>
                  {progress.failed > 0 && <p className="text-xs text-muted-foreground">{progress.failed.toLocaleString()} skipped (invalid email or already suppressed)</p>}
                </div>
              )}

              {done && (
                <div className="flex items-center gap-2 text-sm text-[oklch(0.55_0.16_145)]">
                  <CheckCircle2 className="h-4 w-4" />
                  {progress?.done.toLocaleString()} subscribers imported to "{list.name}"
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          {rows.length > 0 && !done && (
            <Button size="sm" onClick={doImport} disabled={importing || !emailCol}>
              {importing ? "Importing…" : (
                <>Import {rows.length.toLocaleString()} subscribers <ArrowRight className="ml-1 h-3.5 w-3.5" /></>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ListsPage() {
  const { primaryKey } = useAuth();
  const [lists, setLists] = useState<MailingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [hygieneList, setHygieneList] = useState<MailingList | null>(null);
  const [importList, setImportList] = useState<MailingList | null>(null);
  const [preflightList, setPreflightList] = useState<MailingList | null>(null);

  const load = () => {
    if (!primaryKey?.keyRaw) return;
    api.withKey
      .get<{ data: MailingList[] }>("/v1/lists", primaryKey.keyRaw)
      .then((r) => setLists(r.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [primaryKey]);

  const create = async () => {
    if (!primaryKey?.keyRaw) return;
    setSaving(true);
    try {
      await api.withKey.post("/v1/lists", { name: form.name, description: form.description || undefined }, primaryKey.keyRaw);
      toast.success("List created");
      setCreating(false);
      setForm({ name: "", description: "" });
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const remove = async (l: MailingList) => {
    if (!primaryKey?.keyRaw) return;
    if (!confirm(`Delete list "${l.name}"? This cannot be undone.`)) return;
    try {
      await api.withKey.del(`/v1/lists/${l.id}`, primaryKey.keyRaw);
      toast.success("List deleted");
      load();
    } catch (e: unknown) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Mailing Lists</h1>
          <p className="text-sm text-muted-foreground">Manage opt-in subscriber lists with engagement health tracking.</p>
        </header>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New List
        </Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4 max-w-md">
          <h2 className="text-sm font-semibold">New Mailing List</h2>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input placeholder="Newsletter subscribers" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input placeholder="Weekly product updates" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={create} disabled={saving}>{saving ? "Creating…" : "Create List"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center gap-4">
              <div className="h-3 w-48 bg-muted rounded animate-pulse" />
              <div className="h-3 w-20 bg-muted rounded animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      ) : lists.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center">
          <Users className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No mailing lists yet. Create a list, then import your subscribers.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {lists.map((l) => (
            <div key={l.id} className="rounded-lg border border-border bg-card p-5 space-y-3">
              <div>
                <h2 className="font-medium">{l.name}</h2>
                {l.description && <p className="text-xs text-muted-foreground mt-0.5">{l.description}</p>}
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="tabular-nums font-medium">{l.contactCount.toLocaleString()}</span>
                <span className="text-muted-foreground">subscribers</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleDateString()}</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost" size="sm" className="h-7 text-xs gap-1"
                    title="Import subscribers from CSV"
                    onClick={() => setImportList(l)}
                  >
                    <Upload className="h-3.5 w-3.5" /> Import
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 text-xs gap-1 text-[oklch(0.55_0.16_145)]"
                    title="List hygiene analysis"
                    onClick={() => setHygieneList(l)}
                  >
                    <Leaf className="h-3.5 w-3.5" /> Hygiene
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 text-xs gap-1"
                    title="Check likely deliverability before sending"
                    onClick={() => setPreflightList(l)}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Deliverability
                  </Button>
                  <Link to="/dashboard/contacts" search={{ list: l.id }}>
                    <Button variant="outline" size="sm" className="h-7 text-xs">Manage</Button>
                  </Link>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(l)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {hygieneList && primaryKey?.keyRaw && (
        <ListHygieneModal
          list={hygieneList}
          apiKey={primaryKey.keyRaw}
          onClose={() => { setHygieneList(null); load(); }}
        />
      )}

      {importList && primaryKey?.keyRaw && (
        <CsvImportModal
          list={importList}
          apiKey={primaryKey.keyRaw}
          onClose={() => setImportList(null)}
          onDone={() => load()}
        />
      )}

      {preflightList && primaryKey?.keyRaw && (
        <PreflightModal
          list={preflightList}
          apiKey={primaryKey.keyRaw}
          onClose={() => setPreflightList(null)}
        />
      )}
    </div>
  );
}
