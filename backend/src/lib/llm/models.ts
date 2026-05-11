import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;

// Azure OpenAI — model id is "azure-<deployment-name>". The deployment name
// after the prefix must match a deployment that exists in your Azure OpenAI
// resource. The defaults below assume deployments named gpt-5, gpt-5-mini,
// gpt-5-nano; adjust the lists to match what you actually deploy.
export const AZURE_MAIN_MODELS = [
    "azure-gpt-5.4",
    "azure-gpt-5.1",
    "azure-gpt-4.1",
] as const;
export const AZURE_MID_MODELS = ["azure-gpt-4.1-mini"] as const;
export const AZURE_LOW_MODELS = ["azure-gpt-4.1-mini"] as const;

export const DEFAULT_MAIN_MODEL = "azure-gpt-5.4";
export const DEFAULT_TITLE_MODEL = "azure-gpt-4.1-mini";
export const DEFAULT_TABULAR_MODEL = "azure-gpt-4.1-mini";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...AZURE_MAIN_MODELS,
    ...AZURE_MID_MODELS,
    ...AZURE_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("azure-")) return "azure";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && ALL_MODELS.has(id)) return id;
    return fallback;
}
