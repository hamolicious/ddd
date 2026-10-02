const TOKEN_KEY = "ddd.demo.bearer";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name?: string | null;
  readonly is_admin?: boolean;
}

export interface SessionResponse {
  readonly user: User;
  readonly token?: string;
}

export interface AuthBootstrap {
  readonly needs_first_user: boolean;
  readonly invite_required: boolean;
}

export function storedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = storedToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

async function errorFrom(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) message = `${body.error.code ?? response.status}: ${body.error.message}`;
  } catch {
  }
  const error = new Error(message);
  error.name = response.status === 401 ? "Unauthorized" : "ApiError";
  return error;
}

export function authBootstrap(): Promise<AuthBootstrap> {
  return api<AuthBootstrap>("/auth/bootstrap");
}

export async function login(email: string, password: string): Promise<User> {
  const session = await api<SessionResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, bearer: true }),
  });
  rememberToken(session.token);
  return session.user;
}

export async function register(
  email: string,
  password: string,
  invite?: string,
): Promise<User> {
  const session = await api<SessionResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, bearer: true, invite: invite || undefined }),
  });
  rememberToken(session.token);
  return session.user;
}

export function me(): Promise<User> {
  return api<User>("/auth/me");
}

export async function logout(): Promise<void> {
  try {
    await api<void>("/auth/logout", { method: "POST" });
  } finally {
    rememberToken(undefined);
  }
}

export function createDocument(content: string): Promise<{ id: string }> {
  return api<{ id: string }>("/documents", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
