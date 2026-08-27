import { useAuth } from "@/lib/auth-context";

export interface Profile {
  userId: string;
  email: string | null;
  fullName: string | null;
  plan: string | null;
}

export function useProfile() {
  const { user, primaryKey } = useAuth();
  const profile: Profile | null = user
    ? {
        userId: user.id,
        email: user.email,
        fullName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        plan: primaryKey?.plan ?? "free",
      }
    : null;
  return { profile, loading: false, refetch: async () => {} };
}
