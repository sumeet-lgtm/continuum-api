import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth-context";
import { api } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Badge } from "../components/ui/badge";
import {
  UserPlus,
  Trash2,
  Mail,
  RefreshCw,
  Shield,
  User,
} from "lucide-react";

export const Route = createFileRoute("/dashboard/team")({
  component: TeamPage,
});

interface TeamMember {
  id: string;
  workspaceKeyId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  joinedAt: string;
}

interface TeamInvite {
  id: string;
  inviteeEmail: string;
  role: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

function roleBadge(role: string) {
  if (role === "admin") return <Badge className="bg-gray-900 text-white text-xs">Admin</Badge>;
  return <Badge variant="secondary" className="text-xs">Member</Badge>;
}

export default function TeamPage() {
  const { primaryKey, workspaceRole } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  const apiKey = primaryKey?.keyRaw ?? "";
  const isOwnerOrAdmin = !workspaceRole || workspaceRole === "admin";

  const load = async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const [membersRes, invitesRes] = await Promise.all([
        api.withKey.get<{ data: TeamMember[] }>("/v1/team", apiKey),
        api.withKey.get<{ data: TeamInvite[] }>("/v1/team/invites", apiKey),
      ]);
      setMembers(membersRes.data);
      setInvites(invitesRes.data);
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [apiKey]);

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    try {
      await api.withKey.post("/v1/team/invite", { email: inviteEmail.trim(), role: inviteRole }, apiKey);
      setInviteSuccess(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to send invite";
      setInviteError(msg);
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (memberId: string, role: "admin" | "member") => {
    try {
      await api.withKey.patch(`/v1/team/${memberId}`, { role }, apiKey);
      setMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, role } : m));
    } catch { /* no-op */ }
  };

  const removeMember = async (memberId: string) => {
    if (!confirm("Remove this team member?")) return;
    try {
      await api.withKey.del(`/v1/team/${memberId}`, apiKey);
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch { /* no-op */ }
  };

  const revokeInvite = async (inviteId: string) => {
    try {
      await api.withKey.del(`/v1/team/invites/${inviteId}`, apiKey);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch { /* no-op */ }
  };

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Team</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage who has access to this workspace.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Invite form — owners/admins only */}
      {isOwnerOrAdmin && (
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Invite a team member
          </h2>
          <div className="flex gap-2">
            <Input
              placeholder="colleague@company.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendInvite()}
              className="flex-1"
            />
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "admin" | "member")}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
              {inviting ? "Sending…" : "Invite"}
            </Button>
          </div>
          {inviteError && <p className="text-xs text-red-500 mt-2">{inviteError}</p>}
          {inviteSuccess && <p className="text-xs text-green-600 mt-2">{inviteSuccess}</p>}
          <p className="text-xs text-gray-400 mt-2">
            <span className="font-medium">Admin</span> — can manage team, invite members, access all data.{" "}
            <span className="font-medium">Member</span> — read/write access, cannot manage team.
          </p>
        </div>
      )}

      {/* Members list */}
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Members {!loading && `(${members.length})`}
        </h2>
        {loading ? (
          <div className="text-sm text-gray-400 py-4">Loading…</div>
        ) : members.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg text-center">
            No team members yet. Invite someone above.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="h-8 w-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                  <User className="h-4 w-4 text-gray-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{m.email}</p>
                  <p className="text-xs text-gray-400">
                    Joined {new Date(m.joinedAt).toLocaleDateString()}
                    {m.invitedBy ? ` · invited by ${m.invitedBy}` : ""}
                  </p>
                </div>
                {isOwnerOrAdmin ? (
                  <Select
                    value={m.role}
                    onValueChange={(v) => changeRole(m.id, v as "admin" | "member")}
                  >
                    <SelectTrigger className="w-24 h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  roleBadge(m.role)
                )}
                {isOwnerOrAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => removeMember(m.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pending invites */}
      {isOwnerOrAdmin && invites.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
            Pending invitations ({invites.length})
          </h2>
          <div className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
                <Mail className="h-4 w-4 text-gray-300 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{inv.inviteeEmail}</p>
                  <p className="text-xs text-gray-400">
                    {roleBadge(inv.role)}{" "}
                    · expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-gray-400 hover:text-red-500"
                  onClick={() => revokeInvite(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Role info for members */}
      {workspaceRole && workspaceRole !== "admin" && (
        <div className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4">
          <Shield className="h-4 w-4 text-gray-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-gray-500">
            You're a <strong>{workspaceRole}</strong> in this workspace. Contact the workspace owner to change roles or manage invitations.
          </p>
        </div>
      )}
    </div>
  );
}
