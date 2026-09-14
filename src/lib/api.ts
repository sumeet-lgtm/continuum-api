const API_BASE = "https://api.continuumapi.com";

export function getToken(): string | null {
  try {
    return localStorage.getItem("continuum_token");
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem("continuum_token", token);
  } catch {}
}

export function clearToken() {
  try {
    localStorage.removeItem("continuum_token");
  } catch {}
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  useApiKey?: string,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useApiKey) {
    headers["X-API-Key"] = useApiKey;
  } else if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error((err as { error?: string }).error ?? res.statusText), {
      status: res.status,
    });
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  // Calls that use the raw API key instead of session JWT
  withKey: {
    get: <T>(path: string, apiKey: string) => request<T>("GET", path, undefined, apiKey),
    post: <T>(path: string, body: unknown, apiKey: string) =>
      request<T>("POST", path, body, apiKey),
    patch: <T>(path: string, body: unknown, apiKey: string) =>
      request<T>("PATCH", path, body, apiKey),
    put: <T>(path: string, body: unknown, apiKey: string) =>
      request<T>("PUT", path, body, apiKey),
    del: <T>(path: string, apiKey: string) => request<T>("DELETE", path, undefined, apiKey),
  },
};
