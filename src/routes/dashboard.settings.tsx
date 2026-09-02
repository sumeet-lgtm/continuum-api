import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useProfile } from "@/lib/use-profile";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function SettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading } = useProfile();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (profile) setFullName(profile.fullName ?? "");
  }, [profile]);

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
      // non-fatal — user sees no change
    } finally {
      setSaving(false);
    }
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
        <p className="text-sm text-muted-foreground">Manage your account and plan.</p>
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
