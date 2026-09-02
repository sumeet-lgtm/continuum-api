import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, Download } from "lucide-react";

export const Route = createFileRoute("/dashboard/audit-logs")({
  head: () => ({ meta: [{ title: "Audit Logs — Continuum API" }] }),
  component: AuditLogsPage,
});

type AuditRow = {
  id: string;
  action: string;
  actorEmail: string;
  actorIp: string | null;
  targets: unknown;
  orgId: string | null;
  createdAt: string;
};

type EventPage = {
  data: AuditRow[];
  total: number;
  hasMore: boolean;
  nextBefore: string | null;
};

function actionLabel(action: string): string {
  return action.replace(/_/g, " ").replace(/\./g, " › ");
}

function actionColor(action: string): string {
  if (action.includes("sign_in_failed") || action.includes("deprovisioned") || action.includes("revoked"))
    return "bg-[oklch(0.96_0.04_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.85_0.12_27)]";
  if (action.includes("signed_in") || action.includes("provisioned") || action.includes("created"))
    return "bg-[oklch(0.96_0.04_145)] text-[oklch(0.35_0.15_145)] border-[oklch(0.82_0.12_145)]";
  return "bg-muted text-muted-foreground border-border";
}

function targetSummary(targets: unknown): string {
  if (!targets || !Array.isArray(targets)) return "—";
  return (targets as Array<{ type: string; name?: string; id?: string }>)
    .map((t) => t.name ?? t.id ?? t.type)
    .join(", ");
}

function AuditLogsPage() {
  const { user } = useAuth();
  const [page, setPage] = useState<EventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);

  const isAdmin = user?.orgRole === "admin";

  const loadEvents = useCallback(async (before?: string) => {
    const params = new URLSearchParams({ limit: "50" });
    if (before) params.set("before", before);
    return api.get<EventPage>(`/org/audit-logs/events?${params}`);
  }, []);

  useEffect(() => {
    loadEvents()
      .then(setPage)
      .catch(() => setPage({ data: [], total: 0, hasMore: false, nextBefore: null }))
      .finally(() => setLoading(false));
  }, [loadEvents]);

  const loadMore = async () => {
    if (!page?.nextBefore) return;
    setLoadingMore(true);
    try {
      const next = await loadEvents(page.nextBefore);
      setPage((prev) => ({
        ...next,
        data: [...(prev?.data ?? []), ...next.data],
      }));
    } finally {
      setLoadingMore(false);
    }
  };

  const requestExport = async () => {
    setExporting(true);
    try {
      const result = await api.get<{ url: string | null; state: string }>("/org/audit-logs");
      if (result.url) window.open(result.url, "_blank", "noopener");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-medium tracking-tight">Audit Logs</h1>
          <p className="text-sm text-muted-foreground">
            Security-relevant events — sign-ins, key changes, member updates, SCIM provisioning.
          </p>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={requestExport} disabled={exporting} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Generating…" : "Export CSV"}
          </Button>
        )}
      </header>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="divide-y divide-border">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-5 w-36 rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-32 ml-auto" />
              </div>
            ))}
          </div>
        ) : !page || page.data.length === 0 ? (
          <div className="py-16 text-center">
            <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No audit events recorded yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Events appear here as soon as actions are taken.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                    <th className="px-5 py-2.5 font-medium">Time</th>
                    <th className="px-5 py-2.5 font-medium">Event</th>
                    <th className="px-5 py-2.5 font-medium">Actor</th>
                    <th className="px-5 py-2.5 font-medium">Target</th>
                    <th className="px-5 py-2.5 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {page.data.map((row) => (
                    <tr key={row.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleString(undefined, {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit", second: "2-digit",
                        })}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-mono font-medium whitespace-nowrap ${actionColor(row.action)}`}>
                          {actionLabel(row.action)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">{row.actorEmail}</td>
                      <td className="px-5 py-3 text-xs text-muted-foreground truncate max-w-[180px]">
                        {targetSummary(row.targets)}
                      </td>
                      <td className="px-5 py-3 text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {row.actorIp ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {page.hasMore && (
              <div className="px-5 py-3 border-t border-border">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : `Load more (${page.total - page.data.length} remaining)`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">What's captured</p>
        <p>User sign-ins · Sign-in failures · API key created/revoked · Member invited/removed · Role changes · SSO configured · SCIM provisioning/deprovisioning · Domain added/verified · Organization settings updated</p>
      </div>
    </div>
  );
}
