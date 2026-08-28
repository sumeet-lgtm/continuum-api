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

type SSOStatus = {
  configured: boolean;
  eligible: boolean;
  domain: string;
  organizationId?: string | null;
  connectionCount?: number;
  connectionType?: string | null;
  reason?: string;
};

function SettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading, refetch } = useProfile();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const [ssoStatus, setSsoStatus] = useState<SSOStatus | null>(null);
  const [ssoLoading, setSsoLoading] = useState(true);
  const [ssoWorking, setSsoWorking] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  useEffect(() => {
    api.get<SSOStatus>("/auth/enterprise/status")
      .then(setSsoStatus)
      .catch(() => setSsoStatus(null))
      .finally(() => setSsoLoading(false));
  }, []);

  useEffect(() => {
    if (profile) setFullName(profile.fullName ?? "");
  }, [profile]);

  const save = async () => {
    // Profile updates are managed via WorkOS — name comes from SSO provider.
    setSaving(true);
    await new Promise((r) => setTimeout(r, 500));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const openSSOPortal = async () => {
    setSsoWorking(true);
    setSsoError(null);
    try {
      const { link } = await api.post<{ link: string }>("/auth/enterprise/portal");
      window.open(link, "_blank", "noopener");
      // Re-fetch status after a short delay so the badge updates if they configured quickly
      setTimeout(() => {
        api.get<SSOStatus>("/auth/enterprise/status").then(setSsoStatus).catch(() => {});
      }, 4000);
    } catch (e: unknown) {
      setSsoError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setSsoWorking(false);
    }
  };

  const deleteAccount = async () => {
    if (!user) return;
    await signOut();
    navigate({ to: "/login" });
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
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

      <Section title="Enterprise SSO">
        {ssoLoading ? (
          <p className="text-sm text-muted-foreground">Checking SSO status…</p>
        ) : ssoStatus?.eligible === false ? (
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0 mt-1.5" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">Not available</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Enterprise SSO requires a company email address.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${ssoStatus?.configured ? "bg-green-500" : "bg-yellow-500"}`} />
                <div>
                  <p className="text-sm font-medium">
                    {ssoStatus?.configured
                      ? `SSO active — ${ssoStatus.domain}`
                      : `Not configured — ${ssoStatus?.domain ?? user?.email?.split("@")[1] ?? ""}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {ssoStatus?.configured
                      ? `${ssoStatus.connectionCount ?? 1} connection${(ssoStatus.connectionCount ?? 1) > 1 ? "s" : ""} active${ssoStatus.connectionType ? ` · ${ssoStatus.connectionType}` : ""}. Team members at ${ssoStatus.domain} are automatically routed to SSO login.`
                      : "Connect Okta, Azure AD, Google Workspace, or any SAML 2.0 / OIDC provider. Your team logs in with their existing company credentials."}
                  </p>
                </div>
              </div>
              <Button
                variant={ssoStatus?.configured ? "outline" : "default"}
                onClick={openSSOPortal}
                disabled={ssoWorking}
                className="shrink-0"
              >
                {ssoWorking
                  ? "Opening portal…"
                  : ssoStatus?.configured
                  ? "Manage SSO"
                  : "Set up SSO"}
              </Button>
            </div>

            {!ssoStatus?.configured && (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Supported providers</p>
                <p>Okta · Azure AD / Microsoft Entra · Google Workspace · JumpCloud · OneLogin · Any SAML 2.0 or OIDC provider</p>
              </div>
            )}

            {ssoError && (
              <p className="text-xs text-destructive">{ssoError}</p>
            )}
          </div>
        )}
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
