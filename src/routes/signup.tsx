import { createFileRoute } from "@tanstack/react-router";
import { AuthGate } from "./login";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Create your free account — Continuum" }] }),
  component: () => <AuthGate mode="signup" />,
});
