import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, clearToken } from "./api";

const SSO_LOGIN_URL = "https://api.continuumapi.com/auth/sso/login";
const REDIRECT_URI = typeof window !== "undefined"
  ? `${window.location.origin}/callback`
  : "https://app.continuumapi.com/callback";

export interface ContinuumUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface ContinuumApiKey {
  id: string;
  keyPrefix: string;
  keyRaw: string | null;
  label: string | null;
  name: string | null;
  plan: string | null;
  permission: string;
  currentMonthUsage: number;
  monthlyLimit: number | null;
  currentMonthSendUsage: number;
  monthlySendLimit: number | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface MeResponse {
  user: ContinuumUser;
  apiKeys: ContinuumApiKey[];
  primaryKeyId: string | null;
}

interface AuthContextValue {
  user: ContinuumUser | null;
  apiKeys: ContinuumApiKey[];
  primaryKey: ContinuumApiKey | null;
  loading: boolean;
  signIn: () => void;
  signOut: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ContinuumUser | null>(null);
  const [apiKeys, setApiKeys] = useState<ContinuumApiKey[]>([]);
  const [primaryKeyId, setPrimaryKeyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = async () => {
    const token = getToken();
    if (!token) {
      setUser(null);
      setApiKeys([]);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<MeResponse>("/auth/me");
      setUser(me.user);
      setApiKeys(me.apiKeys);
      setPrimaryKeyId(me.primaryKeyId);
    } catch {
      clearToken();
      setUser(null);
      setApiKeys([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Handle callback: ?token=JWT in the URL
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const token = params.get("token");
      if (token) {
        setToken(token);
        params.delete("token");
        const qs = params.toString();
        window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
      }
    }
    loadMe();
  }, []);

  const signIn = () => {
    window.location.href = `${SSO_LOGIN_URL}?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  };

  const signOut = () => {
    clearToken();
    setUser(null);
    setApiKeys([]);
    window.location.href = "/login";
  };

  const primaryKey = apiKeys.find((k) => k.id === primaryKeyId) ?? apiKeys[0] ?? null;

  return (
    <AuthContext.Provider
      value={{ user, apiKeys, primaryKey, loading, signIn, signOut, refreshMe: loadMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
