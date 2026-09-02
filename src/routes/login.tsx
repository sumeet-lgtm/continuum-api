import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Wordmark } from "@/components/Logo";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Continuum API" }] }),
  component: () => <AuthGate mode="signin" />,
});

const API_BASE = "https://api.continuumapi.com";
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}/callback`
    : "https://app.continuumapi.com/callback";

function providerUrl(provider: "google" | "microsoft" | "github" | "sso") {
  return `${API_BASE}/auth/login/${provider}?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z"/>
      <path fill="#00A4EF" d="M13 1h10v10H13z"/>
      <path fill="#7FBA00" d="M1 13h10v10H1z"/>
      <path fill="#FFB900" d="M13 13h10v10H13z"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/>
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
                ? "API key in 30 seconds · no card required · 1k free sends/mo"
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
            <a
              href={providerUrl("microsoft")}
              className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              <MicrosoftIcon />
              {verb} with Microsoft
            </a>
            <a
              href={providerUrl("github")}
              className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-background px-4 py-2.5 text-sm font-medium hover:bg-muted transition-colors"
            >
              <GitHubIcon />
              {verb} with GitHub
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
