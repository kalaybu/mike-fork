import { AzureOpenAI } from "openai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";

// Convention: model ids are "azure-<deployment-name>". The string after the
// "azure-" prefix is passed verbatim to Azure as the deployment name. So if
// the user has an Azure deployment called "gpt-5", they reference it as
// "azure-gpt-5" anywhere in the app.
//
// Required env vars:
//   AZURE_OPENAI_ENDPOINT     — https://<resource>.openai.azure.com
//   AZURE_OPENAI_API_KEY      — admin key from Azure portal
//   AZURE_OPENAI_API_VERSION  — e.g. "2024-10-21" (defaults if unset)

const DEFAULT_API_VERSION = "2024-10-21";
const MAX_COMPLETION_TOKENS = 16384;

function deploymentNameForModel(model: string): string {
    return model.startsWith("azure-") ? model.slice("azure-".length) : model;
}

function client(override?: string | null): AzureOpenAI {
    const apiKey = override?.trim() || process.env.AZURE_OPENAI_API_KEY || "";
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    const apiVersion =
        process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;
    return new AzureOpenAI({ apiKey, endpoint, apiVersion });
}

type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type OpenAIMessage =
    | { role: "system"; content: string }
    | {
          role: "user" | "assistant";
          content: string;
          tool_calls?: OpenAIToolCall[];
      }
    | { role: "tool"; content: string; tool_call_id: string };

export async function streamAzure(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const az = client(apiKeys?.azure);
    const deployment = deploymentNameForModel(model);

    const messages: OpenAIMessage[] = [
        { role: "system", content: systemPrompt },
        ...params.messages.map(
            (m) =>
                ({
                    role: m.role,
                    content: m.content,
                }) as OpenAIMessage,
        ),
    ];

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await az.chat.completions.create({
            model: deployment,
            messages: messages as never,
            tools: tools.length ? (tools as never) : undefined,
            stream: true,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
        });

        // OpenAI streams tool calls in pieces keyed by index. Accumulate
        // arguments as raw text and JSON.parse once at the end.
        const accum = {
            content: "",
            toolCalls: new Map<
                number,
                { id: string; name: string; argText: string }
            >(),
        };
        let finishReason: string | null = null;

        for await (const chunk of stream) {
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta as {
                content?: string | null;
                tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                }>;
            };
            if (delta.content) {
                accum.content += delta.content;
                callbacks.onContentDelta?.(delta.content);
            }
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    let entry = accum.toolCalls.get(tc.index);
                    if (!entry) {
                        entry = { id: tc.id ?? "", name: "", argText: "" };
                        accum.toolCalls.set(tc.index, entry);
                    }
                    if (tc.id) entry.id = tc.id;
                    if (tc.function?.name) entry.name += tc.function.name;
                    if (tc.function?.arguments)
                        entry.argText += tc.function.arguments;
                }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        fullText += accum.content;

        const orderedCalls = Array.from(accum.toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([, e]) => e);

        const toolCalls: NormalizedToolCall[] = [];
        for (const e of orderedCalls) {
            let input: Record<string, unknown> = {};
            try {
                input = e.argText ? JSON.parse(e.argText) : {};
            } catch {
                input = {};
            }
            const call: NormalizedToolCall = {
                id: e.id,
                name: e.name,
                input,
            };
            callbacks.onToolCallStart?.(call);
            toolCalls.push(call);
        }

        if (
            finishReason !== "tool_calls" ||
            toolCalls.length === 0 ||
            !runTools
        ) {
            break;
        }

        const results = await runTools(toolCalls);

        messages.push({
            role: "assistant",
            content: accum.content,
            tool_calls: orderedCalls.map((e) => ({
                id: e.id,
                type: "function",
                function: { name: e.name, arguments: e.argText },
            })),
        });

        for (const r of results) {
            messages.push({
                role: "tool",
                content: r.content,
                tool_call_id: r.tool_use_id,
            });
        }
    }

    return { fullText };
}

export async function completeAzureText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { azure?: string | null };
}): Promise<string> {
    const az = client(params.apiKeys?.azure);
    const deployment = deploymentNameForModel(params.model);
    const messages: OpenAIMessage[] = [];
    if (params.systemPrompt)
        messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });
    const resp = await az.chat.completions.create({
        model: deployment,
        messages: messages as never,
        max_completion_tokens: params.maxTokens ?? 512,
    });
    return resp.choices[0]?.message?.content ?? "";
}
