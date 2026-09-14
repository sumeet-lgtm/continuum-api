import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Wordmark } from "@/components/Logo";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Continuum" }] }),
  component: () => <AuthGate mode="signin" />,
});

const API_BASE = "https://api.continuumapi.com";
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}/callback`
    : "https://app.continuumapi.com/callback";

function providerUrl(provider: "google" | "sso") {
  return `${API_BASE}/auth/login/${provider}?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09zM12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23zM5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62zM12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

export function AuthGate({ mode }: { mode: "signin" | "signup" }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const hasError = params?.get("error") === "sso_failed";
  const errorDetail = params?.get("detail") ?? null;
  const plan = params?.get("plan");

  useEffect(() => {
    if (!loading && user) navigate({ to: "/dashboard" });
  }, [loading, user, navigate]);

  const isSignup = mode === "signup";
  const verb = isSignup ? "Sign up" : "Continue";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-background">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-lg border border-border bg-card p-8 shadow-sm space-y-5">
          <div className="text-center space-y-1">
            <h1 className="text-xl font-display font-medium tracking-tight">
              {isSignup ? "Create your free account" : "Sign in to Continuum"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {isSignup
                ? "Live in 30 seconds · no card required · 1k free sends/mo"
                : "Choose how you'd like to continue."}
            </p>
          </div>

          {hasError && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-xs font-medium text-destructive">Sign-in failed</p>
              {errorDetail && (
                <p className="text-xs text-destructive/80 mt-1 break-all">{errorDetail}</p>
              )}
            </div>
          )}

          {/* Social logins */}
          <div className="space-y-2.5">
            <a
              href={providerUrl("google")}
              className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              <GoogleIcon />
              {verb} with Google
            </a>
          </div>

          {/* SSO divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-2 text-xs text-muted-foreground">or</span>
            </div>
          </div>

          <a
            href={providerUrl("sso")}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Use company SSO
          </a>

          <p className="text-center text-xs text-muted-foreground">
            No password needed{plan ? ` · you'll land on the ${plan} plan` : ""}.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isSignup ? (
            <>Already have an account? <Link to="/login" className="font-medium text-foreground hover:underline">Sign in</Link></>
          ) : (
            <>New here? <Link to="/signup" className="font-medium text-foreground hover:underline">Create a free account</Link></>
          )}
        </p>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Need SSO for your whole team?{" "}
          <a href="mailto:support@continuumapi.com" className="font-medium hover:underline">Talk to us</a>
        </p>
      </div>
    </div>
  );
}
