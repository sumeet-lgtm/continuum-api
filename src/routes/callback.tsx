import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/callback")({
  component: CallbackPage,
});

function CallbackPage() {
  const { loading, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for AuthProvider to finish loadMe() — it extracts the ?token= from
    // the URL, stores it, and calls /auth/me. Only navigate once that resolves.
    if (loading) return;
    if (user) {
      void navigate({ to: "/dashboard" });
    } else {
      void navigate({ to: "/login" });
    }
  }, [loading, user, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <Logo size={36} />
    </div>
  );
}
