// Authenticated fetch wrapper — on 401, attempts a silent token refresh and retries once.
// Falls back to redirecting to /login if the refresh also fails.

let refreshPromise: Promise<boolean> | null = null;

function refreshToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch("/api/auth/refresh", { method: "POST" })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

const AUTH_PATHS = ["/login", "/register", "/auth/"];

export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;

  const refreshed = await refreshToken();
  if (!refreshed) {
    if (typeof window !== "undefined" && !AUTH_PATHS.some((p) => window.location.pathname.startsWith(p))) {
      window.location.replace("/login");
    }
    return res;
  }

  return fetch(input, init);
}
