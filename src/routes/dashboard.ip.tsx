import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/dashboard/ip")({
  component: IpPage,
});

interface IpResponse {
  valid?: boolean;
  ip?: string;
  country?: string;
  city?: string;
  isp?: string;
  org?: string;
  timezone?: string;
  isProxy?: boolean;
  isVpn?: boolean;
  isHosting?: boolean;
  riskScore?: number;
  riskLevel?: "low" | "medium" | "high" | string;
  [k: string]: unknown;
}

function riskClasses(level?: string) {
  if (level === "low") return "bg-[oklch(0.93_0.08_145)] text-[oklch(0.35_0.16_145)] border-[oklch(0.8_0.12_145)]";
  if (level === "medium") return "bg-[oklch(0.95_0.08_85)] text-[oklch(0.4_0.13_70)] border-[oklch(0.8_0.12_85)]";
  if (level === "high") return "bg-[oklch(0.94_0.08_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.8_0.15_27)]";
  return "bg-muted text-muted-foreground border-border";
}

function riskBarColor(score: number) {
  if (score >= 70) return "bg-[oklch(0.58_0.22_27)]";
  if (score >= 40) return "bg-[oklch(0.65_0.16_75)]";
  return "bg-[oklch(0.55_0.16_145)]";
}

function IpPage() {
  const { apiKey } = useApiKey();
  const [ip, setIp] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onLookup = async () => {
    if (!ip || !apiKey?.keyRaw) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/v1/verify/ip`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.keyRaw}`,
        },
        body: JSON.stringify({ ip }),
      });
      const data = (await res.json().catch(() => ({}))) as IpResponse;
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const score = Math.max(0, Math.min(100, result?.riskScore ?? 0));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">IP Intelligence</h1>
        <p className="text-sm text-muted-foreground">Geolocate an IP and detect proxy, VPN, or hosting providers.</p>
      </header>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="8.8.8.8"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onLookup()}
          />
          <Button onClick={onLookup} disabled={loading || !ip || !apiKey}>
            {loading ? "Looking up…" : "Lookup"}
          </Button>
        </div>
        {!apiKey && <p className="mt-2 text-xs text-muted-foreground">No API key configured yet.</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-medium">Result</h2>
              <div className="flex gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                    result.valid
                      ? "bg-[oklch(0.93_0.08_145)] text-[oklch(0.35_0.16_145)] border-[oklch(0.8_0.12_145)]"
                      : "bg-[oklch(0.94_0.08_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.8_0.15_27)]"
                  }`}
                >
                  {result.valid ? "Valid" : "Invalid"}
                </span>
                {result.riskLevel && (
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${riskClasses(result.riskLevel)}`}>
                    {result.riskLevel} risk
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {result.isProxy && <Flag label="Proxy" />}
              {result.isVpn && <Flag label="VPN" />}
              {result.isHosting && <Flag label="Hosting" />}
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Risk score</span>
                <span className="tabular-nums">{score} / 100</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full transition-all ${riskBarColor(score)}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>

            <dl className="mt-5 space-y-2 text-sm">
              <Row
                label="Location"
                value={[result.city, result.country].filter(Boolean).join(", ") || undefined}
              />
              <Row label="ISP" value={result.isp} />
              <Row label="Organization" value={result.org} />
              <Row label="Timezone" value={result.timezone} />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium mb-3">Raw response</h2>
            <pre className="rounded-md bg-muted p-3 overflow-auto text-xs font-mono max-h-96">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

function Flag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[oklch(0.8_0.15_27)] bg-[oklch(0.94_0.08_27)] px-2 py-0.5 text-xs font-medium text-[oklch(0.42_0.18_27)]">
      {label}
    </span>
  );
}
