"use client";

/**
 * Auth-only client. Mimics the small slice of @supabase/supabase-js that the
 * codebase used (auth.signInWithPassword / signUp / signOut / getSession /
 * getUser / onAuthStateChange) so existing call sites keep working. All
 * authentication is now handled by the backend's /auth/* routes.
 *
 * Sessions are persisted in localStorage under STORAGE_KEY. The access_token
 * is the JWT signed by our backend; pass it to backend requests via
 * `Authorization: Bearer <token>`.
 */

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const STORAGE_KEY = "mike_session";

export type Session = {
    access_token: string;
    user: { id: string; email: string };
};

type AuthChangeCallback = (event: string, session: Session | null) => void;

const listeners = new Set<AuthChangeCallback>();

function readSession(): Session | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Session;
        if (!parsed.access_token || !parsed.user) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeSession(session: Session | null) {
    if (typeof window === "undefined") return;
    if (session) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
        window.localStorage.removeItem(STORAGE_KEY);
    }
    const event = session ? "SIGNED_IN" : "SIGNED_OUT";
    for (const cb of listeners) cb(event, session);
}

async function postAuth(
    path: "/login" | "/signup",
    body: { email: string; password: string },
): Promise<Session> {
    const res = await fetch(`${API_BASE}/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.detail || `Request failed (${res.status})`);
    const session: Session = {
        access_token: json.access_token,
        user: json.user,
    };
    writeSession(session);
    return session;
}

export const supabase = {
    auth: {
        async signInWithPassword(args: { email: string; password: string }) {
            try {
                const session = await postAuth("/login", args);
                return {
                    data: { session, user: session.user },
                    error: null as Error | null,
                };
            } catch (e) {
                return {
                    data: { session: null, user: null },
                    error: e as Error,
                };
            }
        },
        async signUp(args: { email: string; password: string }) {
            try {
                const session = await postAuth("/signup", args);
                return {
                    data: { session, user: session.user },
                    error: null as Error | null,
                };
            } catch (e) {
                return {
                    data: { session: null, user: null },
                    error: e as Error,
                };
            }
        },
        async signOut() {
            writeSession(null);
            return { error: null as Error | null };
        },
        async getSession() {
            return {
                data: { session: readSession() },
                error: null as Error | null,
            };
        },
        async getUser(_token?: string) {
            const session = readSession();
            return {
                data: { user: session?.user ?? null },
                error: null as Error | null,
            };
        },
        onAuthStateChange(cb: AuthChangeCallback) {
            listeners.add(cb);
            return {
                data: {
                    subscription: {
                        unsubscribe() {
                            listeners.delete(cb);
                        },
                    },
                },
            };
        },
    },
};
