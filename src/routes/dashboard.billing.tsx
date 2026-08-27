import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useApiKey } from "@/lib/use-api-key";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { trackEvent, PLAN_VALUES } from "@/lib/analytics";

export const Route = createFileRoute("/dashboard/billing")({
  head: () => ({ meta: [{ title: "Billing — Continuum API" }] }),
  component: BillingPage,
});

type PlanId = "starter" | "growth" | "scale";
interface PlanDef {
  id: PlanId;
  name: string;
  price: string;
  quota: string;
  features: string[];
}
const PLANS: PlanDef[] = [
  {
    id: "starter",
    name: "Starter",
    price: "$29",
    quota: "10,000 verifications · 10,000 sends · 5 mailboxes",
    features: [
      "Email verification API",
      "Phone & IP intelligence",
      "Transactional email + templates",
      "Newsletter campaigns & mailing lists",
      "Cold outreach sequences",
      "Inbox warmup",
      "50 monitors · Webhooks",
      "Custom sending domains · SMTP relay",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: "$79",
    quota: "50,000 verifications · 50,000 sends · 25 mailboxes",
    features: [
      "Everything in Starter",
      "AI first-line personalization",
      "Inbox placement testing",
      "Reply detection (IMAP) · Unified inbox",
      "A/B testing for sequences",
      "Campaign health score",
      "Subsequences & trigger automation",
      "200 monitors · Priority support",
    ],
  },
  {
    id: "scale",
    name: "Scale",
    price: "$199",
    quota: "200,000 verifications · 200,000 sends · 100 mailboxes",
    features: [
      "Everything in Growth",
      "99.9% uptime SLA",
      "Dedicated Slack support",
      "Dedicated IP on request",
      "Highest monitor caps",
      "Custom overage rates",
    ],
  },
];

interface UsageDetail { used: number; limit: number; resets_at: string | null; }
interface Usage {
  plan: string | null;
  verifications: UsageDetail;
  sends: UsageDetail;
  usageResetAt: string | null;
}

function BillingPage() {
  const { apiKey, loading, refetch } = useApiKey();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<PlanId | null>(null);

  useEffect(() => {
    if (!apiKey?.keyRaw) {
      if (!loading) setUsageLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.withKey.get<{ plan: string; verifications: UsageDetail; sends: UsageDetail }>(
          "/v1/usage",
          apiKey.keyRaw!,
        );
        if (!cancelled) {
          setUsage({
            plan: data.plan ?? apiKey.plan ?? "free",
            verifications: data.verifications,
            sends: data.sends,
            usageResetAt: data.verifications.resets_at,
          });
          setUsageLoading(false);
        }
      } catch {
        if (!cancelled) setUsageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiKey?.keyRaw, loading]);

  const currentPlan = (usage?.plan ?? "free").toLowerCase();

  const upgrade = async (plan: PlanId) => {
    if (!apiKey?.keyRaw) {
      toast.error("Your API key isn't ready yet. Please try again in a moment.");
      return;
    }
    setCheckoutLoading(plan);
    trackEvent("begin_checkout", {
      value: PLAN_VALUES[plan],
      currency: "USD",
      items: [{ item_id: plan, item_name: plan }],
    });
    try {
      const res = await fetch("https://api.continuumapi.com/v1/billing/checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.keyRaw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string };
      if (!res.ok || !json.url) {
        toast.error(json.error ?? "Could not start checkout. Please try again.");
        setCheckoutLoading(null);
        return;
      }
      window.location.href = json.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
      setCheckoutLoading(null);
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your plan — email verification, transactional sending, newsletter campaigns, and cold outreach sequences.</p>
      </header>

      {/* Current plan card */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium">Current plan</h2>
            <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium capitalize">
              {currentPlan}
            </span>
          </div>
        </div>
        {usage && (
          <div className="mt-4 space-y-3">
            <UsageBar label="Verifications" used={usage.verifications.used} limit={usage.verifications.limit} />
            <UsageBar label="Sends" used={usage.sends.used} limit={usage.sends.limit} />
            {usage.usageResetAt && (
              <p className="text-xs text-muted-foreground">
                Resets on {new Date(usage.usageResetAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Plan grid */}
      <div className="grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.id;
          const busy = checkoutLoading === p.id;
          return (
            <div
              key={p.id}
              className={`rounded-lg border bg-card p-5 flex flex-col ${
                isCurrent ? "border-foreground" : "border-border"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-base font-semibold">{p.name}</h3>
                {isCurrent && (
                  <span className="text-[11px] font-medium text-muted-foreground">CURRENT</span>
                )}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-semibold tracking-tight">{p.price}</span>
                <span className="text-sm text-muted-foreground">/mo</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{p.quota}</p>
              <ul className="mt-4 space-y-1.5 text-sm flex-1">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="h-4 w-4 mt-0.5 text-foreground shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                className="mt-5"
                disabled={isCurrent || busy || !apiKey?.keyRaw}
                variant={isCurrent ? "outline" : "default"}
                onClick={() => upgrade(p.id)}
              >
                {isCurrent ? "Current plan" : busy ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Redirecting…</>
                ) : "Upgrade"}
              </Button>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Payments are processed securely by Dodo Payments. You can change or cancel your plan at any time.
      </p>
      <button className="hidden" onClick={() => { void refetch(); }} />
      {usageLoading ? null : null}
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  const atLimit = used >= limit && limit > 0;
  const warn = !atLimit && pct >= 80;
  const barColor = atLimit ? "bg-red-500" : warn ? "bg-yellow-500" : "bg-foreground";
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-1">
        <span>{label}</span>
        <span className="tabular-nums">{used.toLocaleString()} / {limit.toLocaleString()}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
