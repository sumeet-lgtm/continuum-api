import { useAuth, type ContinuumApiKey } from "@/lib/auth-context";

// Compatibility shim — maps new auth shape to old shape that existing pages expect
export interface ApiKey {
  id: string;
  userId: string;
  prefix: string | null;
  keyRaw: string | null;
  label: string | null;
  rateLimit: number | null;
  isActive: boolean;
  createdAt: string | null;
  lastUsedAt?: string | null;
  plan?: string | null;
  currentMonthUsage?: number;
  monthlyLimit?: number | null;
  usageResetAt?: string | null;
}

function mapKey(k: ContinuumApiKey): ApiKey {
  return {
    id: k.id,
    userId: "",
    prefix: k.keyPrefix,
    keyRaw: k.keyRaw,
    label: k.label,
    rateLimit: null,
    isActive: true,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    plan: k.plan,
    currentMonthUsage: k.currentMonthUsage,
    monthlyLimit: k.monthlyLimit ?? undefined,
    usageResetAt: undefined,
  };
}

export function useApiKey() {
  const { primaryKey, loading } = useAuth();
  return {
    apiKey: primaryKey ? mapKey(primaryKey) : null,
    loading,
    error: null,
    refetch: async () => {},
  };
}
