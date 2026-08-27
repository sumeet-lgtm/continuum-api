import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Wordmark } from "@/components/Logo";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Continuum API" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) navigate({ to: "/dashboard" });
  }, [loading, user, navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-background">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-lg border border-border bg-card p-8 shadow-sm text-center space-y-4">
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Continuum</h1>
          <p className="text-sm text-muted-foreground">
            Use your company email — Google, Microsoft, or any SSO provider.
          </p>
          <Button className="w-full" size="lg" onClick={signIn} disabled={loading}>
            Continue with SSO →
          </Button>
          <p className="text-xs text-muted-foreground">
            No password needed. We use WorkOS AuthKit for secure sign-in.
          </p>
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Need access?{" "}
          <a href="mailto:sumeet@continuumapi.com" className="font-medium text-foreground hover:underline">
            Contact us
          </a>
        </p>
      </div>
    </div>
  );
}
