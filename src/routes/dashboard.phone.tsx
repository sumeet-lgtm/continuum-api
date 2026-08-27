import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { API_BASE } from "@/lib/supabase";
import { useApiKey } from "@/lib/use-api-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/dashboard/phone")({
  head: () => ({ meta: [{ title: "Phone Intelligence — Continuum API" }] }),
  component: PhonePage,
});

interface PhoneResponse {
  valid?: boolean;
  lineType?: string;
  isMobile?: boolean;
  country?: string;
  carrier?: string;
  e164?: string;
  formatted?: string;
  riskLevel?: "low" | "medium" | "high" | string;
  [k: string]: unknown;
}

const COUNTRIES = ["IN", "US", "GB", "CA", "AU", "DE", "FR", "BR", "MX", "JP", "SG", "AE"];

function riskClasses(level?: string) {
  if (level === "low") return "bg-[oklch(0.93_0.08_145)] text-[oklch(0.35_0.16_145)] border-[oklch(0.8_0.12_145)]";
  if (level === "medium") return "bg-[oklch(0.95_0.08_85)] text-[oklch(0.4_0.13_70)] border-[oklch(0.8_0.12_85)]";
  if (level === "high") return "bg-[oklch(0.94_0.08_27)] text-[oklch(0.42_0.18_27)] border-[oklch(0.8_0.15_27)]";
  return "bg-muted text-muted-foreground border-border";
}

function PhonePage() {
  const { apiKey } = useApiKey();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("IN");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PhoneResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onVerify = async () => {
    if (!phone || !apiKey?.keyRaw) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/v1/verify/phone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.keyRaw}`,
        },
        body: JSON.stringify({ phone, country }),
      });
      const data = (await res.json().catch(() => ({}))) as PhoneResponse;
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Phone</h1>
        <p className="text-sm text-muted-foreground">Validate a phone number and detect line type.</p>
      </header>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="w-full sm:w-28">
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            type="tel"
            placeholder="+919876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onVerify()}
          />
          <Button onClick={onVerify} disabled={loading || !phone || !apiKey}>
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </div>
        {!apiKey && <p className="mt-2 text-xs text-muted-foreground">No API key configured yet.</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Result</h2>
              <div className="flex gap-2">
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
            <dl className="mt-4 space-y-2 text-sm">
              <Row label="Line type" value={result.lineType} />
              <Row label="Mobile" value={result.isMobile === undefined ? undefined : result.isMobile ? "Yes" : "No"} />
              <Row label="Country" value={result.country} />
              <Row label="Carrier" value={result.carrier} />
              <Row label="E.164" value={result.e164 ?? result.formatted} mono />
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

function Row({ label, value, mono }: { label: string; value?: string | number; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value ?? "—"}</dd>
    </div>
  );
}
