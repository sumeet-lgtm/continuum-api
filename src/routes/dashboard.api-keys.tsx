import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { useApiKey } from "@/lib/use-api-key";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard/api-keys")({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const { apiKey, loading, refetch } = useApiKey();
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const onCopy = async () => {
    if (!apiKey?.keyRaw) return;
    await navigator.clipboard.writeText(apiKey.keyRaw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const onRevoke = async () => {
    if (!apiKey || !confirm("Revoke this API key? Calls using it will start failing.")) return;
    setRevoking(true);
    try {
      await api.del(`/v1/api-keys/${apiKey.id}`);
    } catch { /* ignore */ }
    await refetch();
    setRevoking(false);
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground">Authenticate requests to the Continuum API.</p>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            alert("Contact sumeet@continuumapi.com to generate a new key.")
          }
        >
          Generate new key
        </Button>
      </header>

      {!apiKey ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            Your API key is being set up. Check your email or contact{" "}
            <a href="mailto:sumeet@continuumapi.com" className="underline text-foreground">
              sumeet@continuumapi.com
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium truncate">{apiKey.label ?? "Default key"}</p>
                <StatusBadge status={apiKey.isActive ? "active" : "revoked"} />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Created {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"}
                {apiKey.rateLimit ? ` · ${apiKey.rateLimit.toLocaleString()} req / month` : ""}
              </p>
            </div>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="text-xs text-muted-foreground">Key</label>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
                  {revealed && apiKey.keyRaw
                    ? apiKey.keyRaw
                    : `${apiKey.prefix ?? "cnt"}_${"•".repeat(24)}`}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevealed((v) => !v)}
                  disabled={!apiKey.keyRaw}
                >
                  {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  <span className="ml-1.5">{revealed ? "Hide" : "Show"}</span>
                </Button>
                <Button variant="outline" size="sm" onClick={onCopy} disabled={!apiKey.keyRaw}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Treat this key like a password — anyone with it can call the API as you.
              </p>
            </div>
            {apiKey.isActive && (
              <div className="pt-3 border-t border-border">
                <Button variant="outline" onClick={onRevoke} disabled={revoking}>
                  {revoking ? "Revoking…" : "Revoke key"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
