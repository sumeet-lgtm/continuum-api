import { useMemo } from "react";
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
  // mapKey() must stay referentially stable across renders when primaryKey
  // hasn't changed -- otherwise every effect/useCallback keyed on `apiKey`
  // (several dashboard pages do this) re-fires every render, in a loop that
  // never settles since each fetch's state update triggers the next render.
  const apiKey = useMemo(() => (primaryKey ? mapKey(primaryKey) : null), [primaryKey]);
  return {
    apiKey,
    loading,
    error: null,
    refetch: async () => {},
  };
}
