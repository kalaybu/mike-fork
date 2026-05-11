"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

type ProfileRow = {
    display_name: string | null;
    organisation: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tier: string | null;
    tabular_model: string | null;
    claude_api_key: string | null;
    gemini_api_key: string | null;
};

async function authedFetch(
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const headers = new Headers(init.headers);
    if (session?.access_token)
        headers.set("Authorization", `Bearer ${session.access_token}`);
    if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
    return fetch(`${API_BASE}${path}`, { ...init, headers });
}

function rowToProfile(row: ProfileRow | null): UserProfile {
    if (!row) {
        const future = new Date();
        future.setDate(future.getDate() + 30);
        return {
            displayName: null,
            organisation: null,
            messageCreditsUsed: 0,
            creditsResetDate: future.toISOString(),
            creditsRemaining: MONTHLY_CREDIT_LIMIT,
            tier: "Free",
            tabularModel: "azure-gpt-4.1-mini",
            claudeApiKey: null,
            geminiApiKey: null,
        };
    }
    return {
        displayName: row.display_name,
        organisation: row.organisation ?? null,
        messageCreditsUsed: row.message_credits_used,
        creditsResetDate: row.credits_reset_date,
        creditsRemaining: MONTHLY_CREDIT_LIMIT - row.message_credits_used,
        tier: row.tier || "Free",
        tabularModel: row.tabular_model || "azure-gpt-4.1-mini",
        claudeApiKey: row.claude_api_key ?? null,
        geminiApiKey: row.gemini_api_key ?? null,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const res = await authedFetch("/user/profile");
            if (!res.ok) {
                setProfile(rowToProfile(null));
                return;
            }
            const json = (await res.json()) as { profile: ProfileRow | null };
            const row = json.profile;

            if (
                row &&
                row.credits_reset_date &&
                new Date() > new Date(row.credits_reset_date)
            ) {
                const newReset = new Date();
                newReset.setDate(newReset.getDate() + 30);
                const resetIso = newReset.toISOString();
                row.message_credits_used = 0;
                row.credits_reset_date = resetIso;
                authedFetch("/user/profile", {
                    method: "PATCH",
                    body: JSON.stringify({
                        message_credits_used: 0,
                        credits_reset_date: resetIso,
                    }),
                }).catch((e) => console.error("Failed to auto-reset credits", e));
            }

            setProfile(rowToProfile(row));
        } catch {
            setProfile(rowToProfile(null));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const patchProfile = useCallback(
        async (body: Record<string, unknown>): Promise<ProfileRow | null> => {
            const res = await authedFetch("/user/profile", {
                method: "PATCH",
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`PATCH /user/profile ${res.status}`);
            const json = (await res.json()) as { profile: ProfileRow };
            return json.profile ?? null;
        },
        [],
    );

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await patchProfile({ display_name: displayName });
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user, patchProfile],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await patchProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, patchProfile],
    );

    const updateModelPreference = useCallback(
        async (field: "tabularModel", value: string): Promise<boolean> => {
            if (!user) return false;
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            try {
                await patchProfile({ [dbField]: value });
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, patchProfile],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const dbField =
                provider === "claude" ? "claude_api_key" : "gemini_api_key";
            const stateField =
                provider === "claude" ? "claudeApiKey" : "geminiApiKey";
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await patchProfile({ [dbField]: normalized });
                setProfile((prev) =>
                    prev ? { ...prev, [stateField]: normalized } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user, patchProfile],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile();
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) return false;
        if (profile.creditsRemaining <= 0) return false;
        const newCreditsUsed = profile.messageCreditsUsed + 1;
        try {
            await patchProfile({ message_credits_used: newCreditsUsed });
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining:
                              MONTHLY_CREDIT_LIMIT - newCreditsUsed,
                      }
                    : null,
            );
            return true;
        } catch {
            return false;
        }
    }, [user, profile, patchProfile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
