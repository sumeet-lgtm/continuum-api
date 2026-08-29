import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard/audit-logs")({
  head: () => ({ meta: [{ title: "Audit Logs — Continuum API" }] }),
  component: AuditLogsPage,
});

type AuditExport = {
  exportId: string | null;
  state: string;
  url: string | null;
  message?: string;
};

function AuditLogsPage() {
  const [exportInfo, setExportInfo] = useState<AuditExport | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api.get<AuditExport>("/org/audit-logs")
      .then(setExportInfo)
      .catch(() => setExportInfo({ exportId: null, state: "unavailable", url: null, message: "Not available for your account." }))
      .finally(() => setLoading(false));
  }, []);

  const requestExport = async () => {
    setExporting(true);
    try {
      const result = await api.get<AuditExport>("/org/audit-logs");
      setExportInfo(result);
      if (result.url) {
        window.open(result.url, "_blank", "noopener");
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          Security-relevant events for your organization — sign-ins, key changes, member updates, and SSO events.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-medium">Event Export</h2>
          <Button size="sm" onClick={requestExport} disabled={exporting || loading}>
            {exporting ? "Generating…" : "Export CSV (last 30 days)"}
          </Button>
        </div>
        <div className="p-5">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : exportInfo?.state === "unavailable" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {exportInfo.message ?? "Audit logs are available for organizations. Set up SSO to get started."}
              </p>
              <p className="text-xs text-muted-foreground">
                Go to <a href="/dashboard/organization" className="underline">Organization</a> to configure SSO and enable audit logging.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm space-y-2">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${exportInfo?.state === "ready" ? "bg-green-500" : exportInfo?.state === "pending" ? "bg-yellow-500" : "bg-muted-foreground/40"}`} />
                  <span className="font-medium capitalize">{exportInfo?.state ?? "Unknown"}</span>
                </div>
                {exportInfo?.exportId && (
                  <p className="text-xs text-muted-foreground">Export ID: {exportInfo.exportId}</p>
                )}
              </div>

              {exportInfo?.url && (
                <div>
                  <a
                    href={exportInfo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-foreground underline underline-offset-4"
                  >
                    Download export
                  </a>
                </div>
              )}

              <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Events captured</p>
                <p>User sign-ins · Sign-in failures · API key created/revoked · Member invited/removed · Role changes · SSO configured · SCIM provisioning/deprovisioning · Domain added/verified · Organization settings updated</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
