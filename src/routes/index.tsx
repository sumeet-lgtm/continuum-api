import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/")({
  component: Index,
});

// app.continuumapi.com is the product, not a second marketing site —
// continuumapi.com already owns that job. Unauthenticated visitors go
// straight to sign-in; authenticated ones straight to the dashboard.
function Index() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    void navigate({ to: user ? "/dashboard" : "/login", replace: true });
  }, [loading, user, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
    </div>
  );
}
