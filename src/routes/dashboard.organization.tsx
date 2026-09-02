import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/dashboard/organization")({
  head: () => ({ meta: [{ title: "Organization — Continuum API" }] }),
  component: OrganizationPage,
});

type OrgInfo = {
  orgId: string | null;
  name: string | null;
  domain: string | null;
  mfaRequired: boolean;
  memberCount: number;
  configured: boolean;
};

type OrgMember = {
  id: string;
  userId: string;
  orgId: string;
  membershipId: string;
  role: string;
  email: string;
  status: string;
  createdAt: string;
};

type Invitation = {
  id: string;
  email: string;
  state: string;
};

function OrganizationPage() {
  const { user } = useAuth();

  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [portalWorking, setPortalWorking] = useState(false);
  const [mfaToggling, setMfaToggling] = useState(false);

  const isAdmin = user?.orgRole === "admin";

  useEffect(() => {
    async function load() {
      try {
        const [orgData, membersData, invitesData] = await Promise.all([
          api.get<OrgInfo>("/org"),
          api.get<{ data: OrgMember[] }>("/org/members"),
          api.get<{ data: Invitation[] }>("/org/invitations").catch(() => ({ data: [] })),
        ]);
        setOrg(orgData);
        setMembers(membersData.data);
        setInvitations(invitesData.data);
      } catch {
        // not part of an org — show setup state
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const openPortal = async () => {
    setPortalWorking(true);
    try {
      const { link } = await api.post<{ link: string }>("/org/portal");
      window.open(link, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to open portal");
    } finally {
      setPortalWorking(false);
    }
  };

  const sendInvite = async () => {
    if (!inviteEmail) return;
    setInviting(true);
    setInviteError(null);
    try {
      const inv = await api.post<Invitation>("/org/invitations", { email: inviteEmail, role: inviteRole });
      setInvitations((prev) => [...prev, inv]);
      setInviteEmail("");
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "Failed to send invitation");
    } finally {
      setInviting(false);
    }
  };

  const revokeInvite = async (id: string) => {
    await api.del(`/org/invitations/${id}`);
    setInvitations((prev) => prev.filter((i) => i.id !== id));
  };

  const removeMember = async (membershipId: string) => {
    await api.del(`/org/members/${membershipId}`);
    setMembers((prev) => prev.filter((m) => m.membershipId !== membershipId));
  };

  const toggleMfa = async () => {
    if (!org) return;
    setMfaToggling(true);
    try {
      const updated = await api.patch<OrgInfo>("/org/settings", { mfaRequired: !org.mfaRequired });
      setOrg((prev) => prev ? { ...prev, mfaRequired: updated.mfaRequired } : prev);
    } finally {
      setMfaToggling(false);
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  if (!org?.configured) {
    return (
      <div className="space-y-6 max-w-2xl">
        <header>
          <h1 className="text-2xl font-display font-medium tracking-tight">Organization</h1>
          <p className="text-sm text-muted-foreground">Manage your team and enterprise SSO.</p>
        </header>
        <Section title="Enterprise SSO">
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Connect Okta, Azure AD, Google Workspace, or any SAML/OIDC provider. Your team logs in with existing company credentials, and new members can be provisioned automatically via SCIM.
            </p>
            <p className="text-xs text-muted-foreground">
              You need a company email address to set up SSO. Logged in as <strong>{user?.email}</strong>.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-display font-medium tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">Manage your team, SSO, and directory sync.</p>
      </header>

      <Section title="Single Sign-On & Directory Sync">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-medium">{org.name ?? org.domain ?? "Your organization"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure SSO providers, Directory Sync (SCIM), and MFA policies from the WorkOS Admin Portal.
            </p>
          </div>
          <Button onClick={openPortal} disabled={portalWorking} className="shrink-0">
            {portalWorking ? "Opening…" : "Open Admin Portal"}
          </Button>
        </div>
      </Section>

      <Section title="Members">
        <div className="space-y-3">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
              {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between px-4 py-3 bg-background">
                  <div>
                    <p className="text-sm font-medium">{m.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Joined {new Date(m.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      m.role === "admin" ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
                    }`}>
                      {m.role}
                    </span>
                    {isAdmin && m.email !== user?.email && (
                      <Button variant="outline" size="sm" onClick={() => removeMember(m.membershipId)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {isAdmin && (
        <Section title="Invite member">
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="inv-email">Email address</Label>
                <Input
                  id="inv-email"
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-role">Role</Label>
                <select
                  id="inv-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <Button onClick={sendInvite} disabled={inviting || !inviteEmail}>
              {inviting ? "Sending…" : "Send invitation"}
            </Button>
            {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
          </div>
        </Section>
      )}

      {invitations.filter((i) => i.state === "pending").length > 0 && (
        <Section title="Pending invitations">
          <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
            {invitations.filter((i) => i.state === "pending").map((inv) => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3 bg-background">
                <p className="text-sm">{inv.email}</p>
                {isAdmin && (
                  <Button variant="outline" size="sm" onClick={() => revokeInvite(inv.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {isAdmin && (
        <Section title="Security">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium">Require MFA for all members</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Members without MFA set up will be prompted on next login.
              </p>
            </div>
            <Button
              variant={org.mfaRequired ? "default" : "outline"}
              onClick={toggleMfa}
              disabled={mfaToggling}
              className="shrink-0"
            >
              {mfaToggling ? "Updating…" : org.mfaRequired ? "MFA enforced" : "Enable MFA"}
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children, tone }: { title: string; children: React.ReactNode; tone?: "danger" }) {
  return (
    <div className={`rounded-lg border ${tone === "danger" ? "border-destructive/30" : "border-border"} bg-card`}>
      <div className="px-5 py-3 border-b border-border">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
