import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth-context";
import { api, setToken } from "../lib/api";
import { Button } from "../components/ui/button";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";

export const Route = createFileRoute("/accept-invite")({
  component: AcceptInvitePage,
});

export default function AcceptInvitePage() {
  const { user, signIn, refreshMe } = useAuth();
  const navigate = useNavigate();
  const [token, setInviteToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    setInviteToken(t);
  }, []);

  const accept = async () => {
    if (!token) return;
    setStatus("loading");
    try {
      const sessionToken = localStorage.getItem("continuum_token") ?? "";
      const res = await fetch("https://api.continuumapi.com/auth/accept-invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? err.message ?? "Failed to accept invite");
      }
      const data = await res.json() as { ok: boolean; token: string; workspaceRole: string };
      setToken(data.token);
      await refreshMe();
      setStatus("success");
      setMessage(`You've joined the workspace as ${data.workspaceRole}. Redirecting…`);
      setTimeout(() => navigate({ to: "/dashboard" }), 1500);
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Failed to accept invite");
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-center max-w-sm">
          <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Invalid invite link</h1>
          <p className="text-sm text-gray-500">This invite link is missing or malformed. Ask for a new invite from the workspace owner.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const redirect = encodeURIComponent(`/accept-invite?token=${token}`);
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-center max-w-sm">
          <div className="h-10 w-10 rounded-full bg-gray-900 dark:bg-white flex items-center justify-center mx-auto mb-4">
            <span className="text-white dark:text-gray-900 font-bold text-sm">C</span>
          </div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">You've been invited</h1>
          <p className="text-sm text-gray-500 mb-6">Sign in to accept your invitation to join this Continuum workspace.</p>
          <Button
            className="w-full"
            onClick={() => {
              window.location.href = `https://api.continuumapi.com/auth/sso/login?redirect_uri=${encodeURIComponent(window.location.origin)}/callback?redirect=/accept-invite%3Ftoken=${token}`;
            }}
          >
            Sign in to accept
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="text-center max-w-sm w-full px-4">
        {status === "success" ? (
          <>
            <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Invite accepted!</h1>
            <p className="text-sm text-gray-500">{message}</p>
          </>
        ) : status === "error" ? (
          <>
            <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-3" />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Couldn't accept invite</h1>
            <p className="text-sm text-red-500 mb-4">{message}</p>
            <Button variant="outline" onClick={() => setStatus("idle")}>Try again</Button>
          </>
        ) : (
          <>
            <div className="h-10 w-10 rounded-full bg-gray-900 dark:bg-white flex items-center justify-center mx-auto mb-4">
              <span className="text-white dark:text-gray-900 font-bold text-sm">C</span>
            </div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">You've been invited</h1>
            <p className="text-sm text-gray-500 mb-1">
              Accepting as <span className="font-medium text-gray-700 dark:text-gray-300">{user.email}</span>
            </p>
            <p className="text-xs text-gray-400 mb-6">Not you? Sign out and sign in with the invited email.</p>
            <Button
              className="w-full"
              onClick={accept}
              disabled={status === "loading"}
            >
              {status === "loading" ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Joining workspace…</>
              ) : (
                "Accept invitation"
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
