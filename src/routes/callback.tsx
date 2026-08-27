import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { getToken } from "@/lib/api";

export const Route = createFileRoute("/callback")({
  component: CallbackPage,
});

function CallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    // Token was already stored by AuthProvider on mount.
    // If we have a token, go to dashboard; otherwise login.
    if (getToken()) {
      navigate({ to: "/dashboard" });
    } else {
      navigate({ to: "/login" });
    }
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
    </div>
  );
}
