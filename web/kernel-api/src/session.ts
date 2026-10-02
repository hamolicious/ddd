import type { Unsubscribe } from "./types.js";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly isAdmin: boolean;
}

export type AuthVia = "cookie" | "bearer";

export interface LogoutOptions {
  readonly discardUnsynced?: boolean;
}

export interface SessionApi {
  readonly user: SessionUser;
  readonly via: AuthVia;
  isAdmin(): boolean;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchPlugin(path: string, init?: RequestInit): Promise<Response>;
  onAuthRequired(listener: () => void): Unsubscribe;
  logout(options?: LogoutOptions): Promise<void>;
}
