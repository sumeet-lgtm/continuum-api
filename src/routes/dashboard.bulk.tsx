import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Upload, ShieldCheck, AlertTriangle, XCircle, Trash2, Building2, WifiOff, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard/bulk")({
  head: () => ({ meta: [{ title: "Bulk Verification — Continuum" }] }),
  component: BulkPage,
});

interface BulkJob {
  id: string;
  fileName: string | null;
  status: string;
  totalEmails: number | null;
  processedCount: number | null;
  createdAt: string | null;
  completedAt?: string | null;
}

interface BulkRow {
  id: string;
  email: string;
  status: string;
  score?: number | null;
  smtpChecked?: boolean | null;
  isDisposable?: boolean | null;
  isRoleAccount?: boolean | null;
  isCatchAll?: boolean | null;
  spfValid?: boolean | null;
  dmarcValid?: boolean | null;
  blacklisted?: boolean | null;
}

const RECOMMENDATION: Record<string, string> = {
  valid: "Safe to send",
  risky: "Send with caution",
  invalid: "Do not send",
  unknown: "Verify manually",
};

function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.max(1, Math.round(ms / 60000));
  return `Completed in ${mins} minute${mins === 1 ? "" : "s"}`;
}

function csvEscape(v: string | number | null | undefined) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const jobIdsKey = (keyId: string) => `continuum_bulk_job_ids_${keyId}`;

function storeJobId(keyId: string, jobId: string) {
  try {
    const stored: string[] = JSON.parse(localStorage.getItem(jobIdsKey(keyId)) ?? "[]");
    if (!stored.includes(jobId)) {
      stored.unshift(jobId);
      localStorage.setItem(jobIdsKey(keyId), JSON.stringify(stored.slice(0, 50)));
    }
  } catch { /* localStorage unavailable */ }
}

function getJobIds(keyId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(jobIdsKey(keyId)) ?? "[]");
  } catch { return []; }
}

function RiskBreakdown({ results }: { results: BulkRow[] }) {
  const n = results.length;
  if (n === 0) return null;

  const count = (pred: (r: BulkRow) => boolean) => results.filter(pred).length;
  const pct = (c: number) => Math.round((c / n) * 100);

  const valid   = count((r) => (r.status ?? "").toLowerCase() === "valid");
  const risky   = count((r) => (r.status ?? "").toLowerCase() === "risky");
  const invalid = count((r) => (r.status ?? "").toLowerCase() === "invalid");

  const disposable  = count((r) => r.isDisposable === true);
  const catchAll    = count((r) => r.isCatchAll === true);
  const roleAccount = count((r) => r.isRoleAccount === true);
  const spfFail     = count((r) => r.spfValid === false);
  const dmarcFail   = count((r) => r.dmarcValid === false);
  const blacklisted = count((r) => r.blacklisted === true);

  return (
    <div className="px-5 py-4 border-b border-border space-y-4">
      {/* Delivery outcome bar */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Deliverability Breakdown</p>
        <div className="flex h-3 rounded-full overflow-hidden gap-px">
          <div className="bg-emerald-500 transition-all" style={{ width: `${pct(valid)}%` }} title={`Valid: ${pct(valid)}%`} />
          <div className="bg-amber-500 transition-all" style={{ width: `${pct(risky)}%` }} title={`Risky: ${pct(risky)}%`} />
          <div className="bg-rose-500 transition-all" style={{ width: `${pct(invalid)}%` }} title={`Invalid: ${pct(invalid)}%`} />
          <div className="bg-muted flex-1" />
        </div>
        <div className="flex items-center gap-5 text-xs">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span className="tabular-nums font-medium">{valid.toLocaleString()}</span>
            <span className="text-muted-foreground">valid ({pct(valid)}%)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            <span className="tabular-nums font-medium">{risky.toLocaleString()}</span>
            <span className="text-muted-foreground">risky ({pct(risky)}%)</span>
          </span>
          <span className="flex items-center gap-1.5">
            <XCircle className="h-3.5 w-3.5 text-rose-500" />
            <span className="tabular-nums font-medium">{invalid.toLocaleString()}</span>
            <span className="text-muted-foreground">invalid ({pct(invalid)}%)</span>
          </span>
        </div>
      </div>

      {/* Flag breakdown */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Risk Flags</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            // Plain-language labels with the technical term as a hover
            // tooltip, not the headline — "Catch-all" read as unexplained
            // jargon here even though Single Verify already spells out
            // exactly this same flag in full ("Unconfirmable — corporate
            // domain... Person may have left — send at your own risk.").
            { icon: Trash2,      label: "Temporary email",    count: disposable,  color: "text-rose-500",   title: "Disposable address — likely used once and abandoned" },
            { icon: Building2,   label: "Can't confirm",      count: catchAll,    color: "text-amber-500",  title: "Catch-all domain — the mail server accepts every address, so we can't confirm this specific mailbox exists" },
            { icon: WifiOff,     label: "Shared inbox",       count: roleAccount, color: "text-orange-500", title: "Role account (info@, support@, etc.) — often low engagement" },
            { icon: ShieldAlert, label: "Sender not verified", count: spfFail,     color: "text-violet-500", title: "SPF check failed — the sending domain doesn't authorize this mail server" },
            { icon: ShieldAlert, label: "No fraud protection", count: dmarcFail,   color: "text-purple-500", title: "DMARC check failed — the domain has no anti-spoofing policy in place" },
            { icon: XCircle,     label: "On spam blocklists",  count: blacklisted, color: "text-red-600",    title: "This IP or domain is flagged by major email blocklist providers" },
          ].map(({ icon: Icon, label, count: c, color, title }) => (
            <div key={label} title={title} className="rounded-md border border-border bg-muted/30 px-3 py-2.5 flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <Icon className={`h-3.5 w-3.5 ${c > 0 ? color : "text-muted-foreground"}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <span className={`text-lg font-semibold tabular-nums ${c > 0 ? color : "text-muted-foreground"}`}>
                {c.toLocaleString()}
              </span>
              <span className="text-xs text-muted-foreground">{pct(c)}% of list</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BulkPage() {
  const { apiKey } = useApiKey();
  const [jobs, setJobs] = useState<BulkJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [active, setActive] = useState<BulkJob | null>(null);
  const [results, setResults] = useState<BulkRow[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    if (!apiKey?.keyRaw) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const ids = getJobIds(apiKey.id);
    if (ids.length === 0) {
      setJobs([]);
      setLoading(false);
      return;
    }
    const fetched = await Promise.all(ids.map(async (id) => {
      try {
        const res = await fetch(`${API_BASE}/v1/bulk-jobs/${id}`, { headers: { "X-API-Key": apiKey.keyRaw! } });
        return res.ok ? (await res.json()) as BulkJob : null;
      } catch { return null; }
    }));
    setJobs(fetched.filter(Boolean) as BulkJob[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  // Poll non-terminal jobs every 5s via the API; stop when all reach completed/failed.
  useEffect(() => {
    if (!apiKey?.keyRaw) return;
    const activeJobs = jobs.filter(
      (j) => j.status !== "completed" && j.status !== "failed",
    );
    if (activeJobs.length === 0) return;
    const key = apiKey.keyRaw;
    const mergeJob = (prev: BulkJob, next: Partial<BulkJob> | null): BulkJob => {
      if (!next) return prev;
      return {
        ...prev,
        ...next,
        // Preserve known totals/progress if the API omits them or returns null/0
        totalEmails: next.totalEmails ?? prev.totalEmails,
        processedCount:
          typeof next.processedCount === "number"
            ? Math.max(next.processedCount, prev.processedCount ?? 0)
            : prev.processedCount,
      };
    };
    const interval = setInterval(async () => {
      try {
        const updates = await Promise.all(
          activeJobs.map(async (j) => {
            const res = await fetch(`${API_BASE}/v1/bulk-jobs/${j.id}`, {
              headers: { "X-API-Key": key },
            });
            if (!res.ok) return null;
            const body = (await res.json()) as Partial<BulkJob> & { id: string };
            return body;
          }),
        );
        setJobs((curr) =>
          curr.map((j) => {
            const u = updates.find((x) => x && x.id === j.id);
            return u ? mergeJob(j, u) : j;
          }),
        );
        setActive((curr) => {
          if (!curr) return curr;
          const u = updates.find((x) => x && x.id === curr.id);
          return u ? mergeJob(curr, u) : curr;
        });
      } catch {
        // network hiccup — try again next tick
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [jobs, apiKey]);

  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

  const onUpload = async (file: File) => {
    if (!apiKey?.keyRaw) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      toast.error(`File too large (${mb} MB) — maximum is 50 MB. Split the CSV into smaller batches.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.info("Large file detected — processing may take 1-2 hours.");
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const [status, responseText] = await new Promise<[number, string]>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const timeoutId = setTimeout(() => xhr.abort(), 60_000);
        xhr.open("POST", `${API_BASE}/v1/bulk-jobs`);
        xhr.setRequestHeader("X-API-Key", apiKey.keyRaw!);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.upload.onload = () => setUploadProgress(100);
        xhr.onload = () => {
          clearTimeout(timeoutId);
          resolve([xhr.status, xhr.responseText]);
        };
        xhr.onerror = () => {
          clearTimeout(timeoutId);
          reject(new Error("Network error during upload"));
        };
        xhr.onabort = () => {
          clearTimeout(timeoutId);
          reject(new DOMException("Aborted", "AbortError"));
        };
        xhr.send(fd);
      });
      if (status < 200 || status >= 300) {
        toast.error(`Upload failed (${status})`);
      } else {
        try {
          const parsed = JSON.parse(responseText);
          const jobId = parsed.id ?? parsed.job_id;
          if (jobId) storeJobId(apiKey.id, jobId);
        } catch { /* response not JSON */ }
      }
      await load();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast.error("Upload timed out after 60 seconds — try a smaller file or split it into batches.");
      } else {
        toast.error(e instanceof Error ? e.message : "Upload failed");
      }
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const openJob = async (job: BulkJob) => {
    setActive(job);
    setResults([]);
    const res = await fetch(`${API_BASE}/v1/bulk-jobs/${job.id}/results?limit=200`, { headers: { "X-API-Key": apiKey?.keyRaw ?? "" } });
    const data = res.ok ? await res.json() : {};
    setResults((Array.isArray(data) ? data : (data?.data ?? [])) as BulkRow[]);
  };

  const downloadResults = async () => {
    if (!active || !apiKey?.keyRaw) return;
    setDownloading(true);
    try {
      const limit = 1000;
      const all: BulkRow[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const res = await fetch(
          `${API_BASE}/v1/bulk-jobs/${active.id}/results?limit=${limit}&page=${page}`,
          { headers: { Authorization: `Bearer ${apiKey.keyRaw}` } },
        );
        if (!res.ok) {
          toast.error(`Download failed (${res.status})`);
          return;
        }
        const data = await res.json();
        const rows: BulkRow[] = Array.isArray(data)
          ? data
          : (data.results ?? data.data ?? []);
        all.push(...rows);
        totalPages =
          data?.totalPages ??
          data?.pagination?.totalPages ??
          (data?.total && data?.limit ? Math.ceil(data.total / data.limit) : 1);
        page += 1;
      } while (page <= totalPages);

      const fmtBool = (v: boolean | null | undefined) =>
        v === true ? "true" : v === false ? "false" : "";
      const header = [
        "email",
        "status",
        "score",
        "recommendation",
        "smtpChecked",
        "isDisposable",
        "isRoleAccount",
        "isCatchAll",
        "spfValid",
        "dmarcValid",
        "blacklisted",
      ].join(",");
      const body = all.map((r) => {
        const status = (r.status ?? "unknown").toLowerCase();
        const rec = RECOMMENDATION[status] ?? RECOMMENDATION.unknown;
        return [
          csvEscape(r.email),
          csvEscape(status),
          csvEscape(r.score ?? ""),
          csvEscape(rec),
          csvEscape(fmtBool(r.smtpChecked)),
          csvEscape(fmtBool(r.isDisposable)),
          csvEscape(fmtBool(r.isRoleAccount)),
          csvEscape(fmtBool(r.isCatchAll)),
          csvEscape(fmtBool(r.spfValid)),
          csvEscape(fmtBool(r.dmarcValid)),
          csvEscape(fmtBool(r.blacklisted)),
        ].join(",");
      });
      const csv = [header, ...body].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${active.fileName ?? "results"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Bulk Jobs</h1>
          <p className="text-sm text-muted-foreground">Upload a CSV with any columns. We automatically detect the email column by header name. Supported column names: email, email_address, e-mail. Maximum file size: 50MB.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading || !apiKey}>
            <Upload className="h-4 w-4 mr-2" />
            {uploading ? `Uploading… ${uploadProgress}%` : "Upload CSV"}
          </Button>
          {uploading && (
            <div className="w-64">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-foreground transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1 text-right">
                {uploadProgress < 100
                  ? `Uploading file… ${uploadProgress}%`
                  : "Upload complete, starting job…"}
              </p>
            </div>
          )}
        </div>
      </header>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 py-2">
                <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
                <div className="flex-1 h-1.5 rounded-full bg-muted animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-muted-foreground">No bulk jobs yet.</p>
            <p className="text-xs text-muted-foreground">Upload a CSV of email addresses to verify them all in one go — results are downloadable when complete.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-5 py-2 font-medium">File</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Progress</th>
                <th className="px-5 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const total = j.totalEmails ?? 0;
                const processed = j.processedCount ?? 0;
                const pct = total ? Math.round((processed / total) * 100) : 0;
                const isProcessing = j.status !== "completed" && j.status !== "failed";
                const duration = j.status === "completed" ? formatDuration(j.createdAt, j.completedAt ?? null) : null;
                return (
                  <tr
                    key={j.id}
                    onClick={() => openJob(j)}
                    className="border-b border-border last:border-0 cursor-pointer hover:bg-muted/40"
                  >
                    <td className="px-5 py-3 font-medium">{j.fileName ?? "Untitled"}</td>
                    <td className="px-5 py-3"><StatusBadge status={j.status} /></td>
                    <td className="px-5 py-3 w-72">
                      {isProcessing && (
                        <p className="text-xs text-muted-foreground mb-1">
                          {total > 0
                            ? `Verified ${processed.toLocaleString()} of ${total.toLocaleString()} emails…`
                            : `Verified ${processed.toLocaleString()} emails…`}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground w-20 text-right">
                          {total > 0 ? `${processed}/${total}` : processed}
                        </span>
                      </div>
                      {duration && (
                        <p className="text-xs text-muted-foreground mt-1">{duration}</p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {j.createdAt ? new Date(j.createdAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {active && (
        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium truncate">{active.fileName}</h2>
              <p className="text-xs text-muted-foreground">{results.length.toLocaleString()} rows</p>
            </div>
            <div className="flex items-center gap-2">
              {active.status === "completed" && (
                <Button variant="outline" size="sm" onClick={downloadResults} disabled={downloading}>
                  {downloading ? "Preparing download…" : "Download CSV"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
                Close
              </Button>
            </div>
          </div>

          {results.length > 0 && <RiskBreakdown results={results} />}

          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/30 sticky top-0">
                  <th className="px-5 py-2 font-medium">Email</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Score</th>
                  <th className="px-5 py-2 font-medium">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const status = (r.status ?? "unknown").toLowerCase();
                  const rec = RECOMMENDATION[status] ?? RECOMMENDATION.unknown;
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-5 py-2.5 font-mono text-xs">{r.email}</td>
                      <td className="px-5 py-2.5"><StatusBadge status={r.status} /></td>
                      <td className="px-5 py-2.5 tabular-nums text-xs font-mono">{r.score ?? "—"}</td>
                      <td className="px-5 py-2.5 text-xs text-muted-foreground">{rec}</td>
                    </tr>
                  );
                })}
                {results.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-sm text-muted-foreground">No results yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
