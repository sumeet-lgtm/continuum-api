import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useProfile } from "@/lib/use-profile";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({ meta: [{ title: "Settings — Continuum API" }] }),
  component: SettingsPage,
});

const TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
  "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney",
  "Pacific/Auckland",
];

function LS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? (JSON.parse(v) as T) : fallback;
  } catch { return fallback; }
}
function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className="relative flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-muted transition-colors data-[state=checked]:bg-foreground data-[state=checked]:border-foreground disabled:opacity-40 disabled:cursor-not-allowed"
      data-state={enabled ? "checked" : "unchecked"}
    >
      <span className="absolute left-0.5 h-3.5 w-3.5 rounded-full bg-background border border-border shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:border-transparent" data-state={enabled ? "checked" : "unchecked"} />
    </button>
  );
}

function SettingsPage() {
  const { user, signOut, primaryKey } = useAuth();
  const { profile, loading } = useProfile();
  const navigate = useNavigate();

  // Account
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Notifications
  const [usageAlerts, setUsageAlerts] = useState(true);
  const [togglingAlert, setTogglingAlert] = useState(false);
  const [notifLoaded, setNotifLoaded] = useState(false);

  // Developer defaults (localStorage)
  const [defaultFrom, setDefaultFrom] = useState(() => LS("cnt_default_from", ""));
  const [timezone, setTimezone] = useState(() => LS("cnt_default_tz", "UTC"));
  const [devSaved, setDevSaved] = useState(false);

  // Delete account
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (profile) setFullName(profile.fullName ?? "");
  }, [profile]);

  // Load usageAlertEnabled for primary key
  useEffect(() => {
    if (!primaryKey?.keyRaw) return;
    fetch("https://api.continuumapi.com/v1/api-keys", {
      headers: { "X-API-Key": primaryKey.keyRaw },
    })
      .then((r) => r.json())
      .then((data: unknown) => {
        const keys = (data as { data?: Array<{ id: string; usageAlertEnabled?: boolean }> }).data ?? [];
        const mine = keys.find((k) => k.id === primaryKey.id);
        if (mine) setUsageAlerts(mine.usageAlertEnabled !== false);
      })
      .catch(() => {})
      .finally(() => setNotifLoaded(true));
  }, [primaryKey]);

  const save = async () => {
    setSaving(true);
    try {
      const [first, ...rest] = fullName.trim().split(" ");
      await api.patch("/auth/profile", {
        firstName: first || null,
        lastName: rest.join(" ") || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // non-fatal
    } finally {
      setSaving(false);
    }
  };

  const toggleUsageAlerts = async (next: boolean) => {
    if (!primaryKey?.keyRaw || !primaryKey?.id || togglingAlert) return;
    setTogglingAlert(true);
    const prev = usageAlerts;
    setUsageAlerts(next);
    try {
      await fetch(`https://api.continuumapi.com/v1/api-keys/${primaryKey.id}/usage-alerts`, {
        method: "PATCH",
        headers: { "X-API-Key": primaryKey.keyRaw, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      toast.success(next ? "Usage alert emails enabled" : "Usage alert emails disabled");
    } catch {
      setUsageAlerts(prev);
      toast.error("Failed to update notification setting");
    } finally {
      setTogglingAlert(false);
    }
  };

  const saveDevDefaults = () => {
    lsSet("cnt_default_from", defaultFrom.trim());
    lsSet("cnt_default_tz", timezone);
    setDevSaved(true);
    setTimeout(() => setDevSaved(false), 1500);
  };

  const deleteAccount = async () => {
    if (!user) return;
    try {
      await api.del("/auth/account");
    } catch { /* best-effort */ }
    signOut();
    navigate({ to: "/login" });
  };

  if (loading) return (
    <div className="space-y-6 max-w-2xl">
      <header><div className="h-8 w-24 bg-muted rounded animate-pulse mb-2" /><div className="h-4 w-48 bg-muted rounded animate-pulse" /></header>
      {[...Array(4)].map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3 border-b border-border"><div className="h-4 w-32 bg-muted rounded animate-pulse" /></div>
          <div className="p-5 space-y-3"><div className="h-4 w-full bg-muted rounded animate-pulse" /><div className="h-4 w-3/4 bg-muted rounded animate-pulse" /></div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account, notifications, and developer defaults.</p>
      </header>

      <Section title="Account">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={user?.email ?? ""} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fn">Full name</Label>
            <Input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {saved && <span className="text-xs text-muted-foreground">Saved.</span>}
          </div>
        </div>
      </Section>

      <Section title="Notifications">
        <div className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Alerts are sent to <strong>{user?.email}</strong>.
          </p>

          <NotifRow
            title="Usage limit alerts"
            desc="Email me when I reach 80% of my monthly verification or send quota."
            enabled={usageAlerts}
            onChange={toggleUsageAlerts}
            disabled={togglingAlert || !notifLoaded || !primaryKey}
          />

          <NotifRow
            title="Bounce rate alerts"
            desc="Notify me when my 7-day bounce rate exceeds 2% or complaint rate exceeds 0.1%."
            enabled={false}
            onChange={() => toast.info("Bounce rate alerts are configured via the Monitoring page.")}
            disabled={false}
            badge="via Monitoring"
          />

          <NotifRow
            title="Webhook failure alerts"
            desc="Email me when a webhook endpoint fails 5 or more consecutive deliveries."
            enabled={true}
            onChange={() => toast.info("Webhook failure alerts are always active while your webhook is registered.")}
            disabled={false}
            badge="always on"
          />

          <NotifRow
            title="Weekly activity digest"
            desc="Receive a summary of sends, verifications, and deliverability every Monday."
            enabled={false}
            onChange={() => toast.info("Weekly digests are coming soon.")}
            disabled={true}
            badge="coming soon"
          />
        </div>
      </Section>

      <Section title="Developer defaults">
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            These defaults pre-fill the Send Email form. Stored in your browser only.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="default-from">Default "From" address</Label>
            <Input
              id="default-from"
              placeholder="noreply@yourapp.com"
              value={defaultFrom}
              onChange={(e) => setDefaultFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tz">Default timezone for scheduled sends</Label>
            <select
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={saveDevDefaults}>Save defaults</Button>
            {devSaved && <span className="text-xs text-muted-foreground">Saved to browser.</span>}
          </div>
        </div>
      </Section>

      <Section title="Plan">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-medium capitalize">{profile?.plan ?? "Free"} plan</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {(profile?.plan ?? "free") === "free"
                ? "Upgrade to unlock cold outreach sequences, multi-mailbox warmup, AI personalization, and higher quotas."
                : "Manage your quota, billing, and plan details from the Billing tab."}
            </p>
          </div>
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium capitalize">
            {profile?.plan ?? "free"}
          </span>
        </div>
      </Section>

      <Section title="Danger zone" tone="danger">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-medium">Delete account</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Permanently remove your profile and revoke API access.
            </p>
          </div>
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            Delete account
          </Button>
        </div>
      </Section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This action cannot be undone. Type <strong>DELETE</strong> to confirm.
          </p>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              onClick={deleteAccount}
              disabled={confirmText !== "DELETE"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NotifRow({
  title, desc, enabled, onChange, disabled, badge,
}: {
  title: string;
  desc: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  badge?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {badge && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground font-medium">{badge}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Toggle enabled={enabled} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div className={`rounded-lg border ${tone === "danger" ? "border-destructive/30" : "border-border"} bg-card`}>
      <div className="px-5 py-3 border-b border-border">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
