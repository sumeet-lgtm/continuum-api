import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Terminal, CheckCircle2, XCircle, Clock, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/logs")({
  head: () => ({ meta: [{ title: "API Logs — Continuum API" }] }),
  component: LogsPage,
});

interface LogEntry {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  sourceIp: string | null;
  requestId: string | null;
  errorCode: string | null;
  createdAt: string;
}

interface LogSummary {
  window: string;
  total: number;
  success: number;
  errors: number;
  error_rate: number;
  avg_ms: number;
  p99_ms: number;
  top_endpoints: Array<{ path: string; count: number }>;
}

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-muted text-foreground/80",
  POST:   "bg-foreground text-background",
  PATCH:  "bg-[oklch(0.96_0.04_75)] text-[oklch(0.45_0.12_75)]",
  DELETE: "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)]",
};

function statusColor(code: number) {
  if (code >= 500) return "text-[oklch(0.58_0.22_27)]";
  if (code >= 400) return "text-[oklch(0.65_0.16_75)]";
  return "text-[oklch(0.45_0.14_145)]";
}

function latencyColor(ms: number) {
  if (ms > 2000) return "text-[oklch(0.58_0.22_27)]";
  if (ms > 800)  return "text-[oklch(0.65_0.16_75)]";
  return "text-muted-foreground";
}

function LogsPage() {
  const { primaryKey } = useAuth();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<LogSummary | null>(null);

  const [method, setMethod] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState("");

  const limit = 50;

  const load = useCallback(async (pg = 1) => {
    if (!primaryKey?.keyRaw) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(limit) });
      if (method) params.set("method", method);
      if (path.trim()) params.set("path", path.trim());
      if (status) params.set("status", status);

      const [logsRes, summaryRes] = await Promise.all([
        fetch(`https://api.continuumapi.com/v1/logs?${params}`, {
          headers: { "X-API-Key": primaryKey.keyRaw! },
        }),
        pg === 1 ? fetch("https://api.continuumapi.com/v1/logs/summary", {
          headers: { "X-API-Key": primaryKey.keyRaw! },
        }) : null,
      ]);

      if (logsRes.ok) {
        const data = await logsRes.json() as { data: LogEntry[]; total: number };
        setEntries(data.data ?? []);
        setTotal(data.total ?? 0);
        setPage(pg);
      }
      if (summaryRes?.ok) {
        const s = await summaryRes.json() as LogSummary;
        setSummary(s);
      }
    } finally {
      setLoading(false);
    }
  }, [primaryKey, method, path, status]);

  useEffect(() => {
    void load(1);
  }, [load]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">API Logs</h1>
          <p className="text-sm text-muted-foreground">
            Every authenticated request made with your API key. Retained for 30 days.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(1)} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {/* Summary tiles */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Requests (24h)", value: summary.total.toLocaleString(), icon: Terminal },
            { label: "Success rate", value: `${(100 - summary.error_rate).toFixed(1)}%`, icon: CheckCircle2 },
            { label: "Avg latency", value: `${summary.avg_ms}ms`, icon: Clock },
            { label: "p99 latency", value: `${summary.p99_ms}ms`, icon: Zap },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <p className="text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All statuses</option>
          <option value="success">2xx success</option>
          <option value="error">4xx/5xx error</option>
        </select>
        <Input
          placeholder="Filter by path, e.g. /v1/send"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(1)}
          className="h-8 text-xs w-48"
        />
        <Button size="sm" variant="outline" onClick={() => load(1)} className="h-8 text-xs">
          Apply
        </Button>
        {(method || status || path) && (
          <button
            type="button"
            onClick={() => { setMethod(""); setStatus(""); setPath(""); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {total.toLocaleString()} total
        </span>
      </div>

      {/* Log table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-border">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-5 w-14 rounded-full" />
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-10 ml-auto" />
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="py-16 text-center">
            <Terminal className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No requests logged yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Make your first API call and it will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[700px]">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium w-16">Method</th>
                    <th className="px-4 py-2.5 text-left font-medium">Path</th>
                    <th className="px-4 py-2.5 text-left font-medium w-16">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium w-20">Latency</th>
                    <th className="px-4 py-2.5 text-left font-medium w-24">IP</th>
                    <th className="px-4 py-2.5 text-left font-medium w-36">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-muted/20 transition-colors group">
                      <td className="px-4 py-2.5">
                        <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-bold", METHOD_COLORS[entry.method] ?? "bg-muted text-foreground")}>
                          {entry.method}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-foreground/80">
                        {entry.path}
                        {entry.errorCode && (
                          <span className="ml-2 text-[10px] text-[oklch(0.65_0.16_75)] font-sans">{entry.errorCode}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn("font-mono font-semibold tabular-nums", statusColor(entry.statusCode))}>
                          {entry.statusCode}
                        </span>
                      </td>
                      <td className={cn("px-4 py-2.5 font-mono tabular-nums", latencyColor(entry.durationMs))}>
                        {entry.durationMs}ms
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground font-mono">
                        {entry.sourceIp ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit", second: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <Button variant="outline" size="sm" onClick={() => load(page - 1)} disabled={page <= 1 || loading}>
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <Button variant="outline" size="sm" onClick={() => load(page + 1)} disabled={page >= totalPages || loading}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {summary && summary.top_endpoints.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold mb-3">Top endpoints (last 24h)</h2>
          <div className="space-y-2">
            {summary.top_endpoints.map(({ path: ep, count }) => {
              const pct = summary.total > 0 ? (count / summary.total) * 100 : 0;
              return (
                <div key={ep} className="flex items-center gap-3">
                  <span className="font-mono text-xs text-foreground/80 w-40 truncate shrink-0">{ep}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-foreground/50 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground w-10 text-right shrink-0">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
