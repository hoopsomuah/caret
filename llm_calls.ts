import { createGoogleGenerativeAI, google, GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { Notice } from "obsidian";
import { streamText, StreamTextResult, CoreTool, generateText, generateObject } from "ai";
import { OpenAIProvider } from "@ai-sdk/openai";
import { AnthropicProvider } from "@ai-sdk/anthropic";
import { GroqProvider, createGroq } from "@ai-sdk/groq";
import { createOllama, OllamaProvider, ollama } from "ollama-ai-provider";
import { createOpenRouter, OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible, OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { experimental_generateImage as generateImage } from "ai";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";

import { z } from "zod";
import CaretPlugin from "main";
import { XaiProvider } from "@ai-sdk/xai";
import { CopilotClient } from "@github/copilot-sdk";

// Zod validation for message structure
const MessageSchema = z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
});

const ConversationSchema = z.array(MessageSchema);

/**
 * Result object from copilot_sdk_streaming().
 * Compatible with Caret's StreamTextResult.textStream consumption pattern.
 */
export interface CopilotStreamResult {
    /** Async iterable of text chunks - matches StreamTextResult.textStream pattern */
    textStream: AsyncIterable<string>;
    /** Optional reasoning stream for models that support chain-of-thought */
    reasoningStream?: AsyncIterable<string>;
    /** Reference to the underlying session for advanced use cases */
    session: CopilotSession;
    /** Abort the current message without destroying the session */
    abort: () => void;
    /** Clean up the session - call when done consuming the stream */
    cleanup: () => Promise<void>;
}

/**
 * Generic async queue that bridges event callbacks to async iterables.
 * Handles backpressure, error propagation, and completion signaling.
 */
class AsyncEventQueue<T> {
    private queue: T[] = [];
    private resolvers: Array<(value: IteratorResult<T>) => void> = [];
    private rejecters: Array<(error: Error) => void> = [];
    private done = false;
    private error: Error | null = null;
    private readonly maxSize: number;

    constructor(maxSize: number = 1000) {
        this.maxSize = maxSize;
    }

    /**
     * Push a value to the queue. If a consumer is waiting, resolve immediately.
     * When no consumers are waiting, values are buffered up to maxSize.
     */
    push(value: T): void {
        if (this.done) return;
        
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            this.rejecters.shift(); // Remove corresponding rejecter
            resolve({ value, done: false });
        } else {
            // Drop oldest item if queue is full to prevent unbounded growth
            if (this.queue.length >= this.maxSize) {
                this.queue.shift();
                console.warn(`AsyncEventQueue: Queue exceeded maxSize (${this.maxSize}), dropping oldest item`);
            }
            this.queue.push(value);
        }
    }

    /**
     * Signal completion. Any waiting consumers will receive done: true.
     */
    complete(): void {
        this.done = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift()!;
            this.rejecters.shift(); // Remove corresponding rejecter
            resolve({ value: undefined as T, done: true });
        }
    }

    /**
     * Signal an error. Any waiting consumers will have the error thrown.
     */
    fail(error: Error): void {
        this.error = error;
        this.done = true;
        // Reject all waiting consumers with the error
        while (this.rejecters.length > 0) {
            const reject = this.rejecters.shift()!;
            this.resolvers.shift(); // Remove corresponding resolver
            reject(error);
        }
    }

    /**
     * Create an async iterator that yields values as they are pushed.
     */
    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: (): Promise<IteratorResult<T>> => {
                // Always drain queued items first, even if an error has been set
                if (this.queue.length > 0) {
                    return Promise.resolve({ value: this.queue.shift()!, done: false });
                }
                
                if (this.error) {
                    return Promise.reject(this.error);
                }
                
                if (this.done) {
                    return Promise.resolve({ value: undefined as T, done: true });
                }
                
                return new Promise((resolve, reject) => {
                    this.resolvers.push(resolve);
                    this.rejecters.push(reject);
                });
            }
        };
    }
}

export type sdk_provider =
    | GoogleGenerativeAIProvider
    | OpenAIProvider
    | AnthropicProvider
    | GroqProvider
    | OllamaProvider
    | OpenRouterProvider
    | OpenAICompatibleProvider
    | CopilotClient;
export type eligible_provider =
    | "google"
    | "openai"
    | "anthropic"
    | "groq"
    | "ollama"
    | "openrouter"
    | "custom"
    | "perplexity"
    | "github-copilot";

export type image_provider = OpenAIProvider | XaiProvider;

const refactored_providers = ["openai", "google", "anthropic", "groq", "ollama", "openrouter", "custom", "perplexity", "github-copilot"];
export const isEligibleProvider = (provider: string): provider is eligible_provider => {
    return refactored_providers.includes(provider);
};
export function get_provider(plugin: CaretPlugin, provider: eligible_provider): sdk_provider {
    switch (provider) {
        case "openai":
            return plugin.openai_client;
        case "google":
            return plugin.google_client;
        case "anthropic":
            return plugin.anthropic_client;
        case "groq":
            return plugin.groq_client;
        case "ollama":
            return plugin.ollama_client;
        case "openrouter":
            return plugin.openrouter_client;
        case "perplexity":
            return plugin.perplexity_client;
        case "github-copilot":
            return plugin.copilot_client;
        case "custom":
            const settings = plugin.settings;
            const current_model = settings.model;
            const custom_endpoint = settings.custom_endpoints[current_model];

            if (!custom_endpoint) {
                throw new Error(`No custom endpoint configuration found for model: ${current_model}`);
            }

            const sdk_provider = createOpenAICompatible({
                baseURL: custom_endpoint.endpoint,
                apiKey: custom_endpoint.api_key,
                name: provider,
            });

            plugin.custom_client = sdk_provider;
            return plugin.custom_client;
        default:
            throw new Error(
                `Invalid provider: ${provider}. Must be one of: ${refactored_providers.join(", ")}`
            );
    }
}
export async function ai_sdk_streaming(
    provider: sdk_provider,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    temperature: number,
    provider_name: eligible_provider
): Promise<StreamTextResult<Record<string, CoreTool<any, any>>, never>> {
    new Notice(`Calling ${provider_name[0].toUpperCase() + provider_name.slice(1)}`);

    // Validate conversation structure
    const validatedConversation = ConversationSchema.parse(conversation);

    const handleError = (event: unknown) => {
        const error = (event as { error: unknown }).error;
        const typedError = error as { errors: Array<{ statusCode: number }> };
        const errors = typedError.errors;

        if (errors?.some((e) => e.statusCode === 429)) {
            console.error("Rate limit exceeded error");
            new Notice(`Rate limit exceeded for ${provider_name} API`);
        } else {
            new Notice(`Unknown error during ${provider_name} streaming`);
        }
    };

    if (provider_name === "openrouter") {
        const openrouter_provider = provider as OpenRouterProvider;
        return await streamText({
            model: openrouter_provider.chat(model),
            messages: validatedConversation,
            temperature,
            onError: handleError,
        });
    }

    const final_provider = provider as Exclude<sdk_provider, OpenRouterProvider>;
    const stream = await streamText({
        model: final_provider(model),
        messages: validatedConversation,
        temperature,
        onError: handleError,
    });

    return stream;
}
export async function ai_sdk_completion(
    provider: sdk_provider,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    temperature: number,
    provider_name: eligible_provider
): Promise<string> {
    new Notice(`Calling ${provider_name[0].toUpperCase() + provider_name.slice(1)}`);

    // Validate conversation structure
    const validatedConversation = ConversationSchema.parse(conversation);

    if (provider_name === "openrouter") {
        const openrouter_provider = provider as OpenRouterProvider;
        const response = await generateText({
            model: openrouter_provider.chat(model),
            messages: validatedConversation,
            temperature,
        });
        return response.text;
    }

    const final_provider = provider as Exclude<sdk_provider, OpenRouterProvider>;
    const response = await generateText({
        model: final_provider(model),
        messages: validatedConversation,
        temperature,
    });

    return response.text;
}
export async function ai_sdk_structured<T extends z.ZodType>(
    provider: sdk_provider,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    temperature: number,
    provider_name: eligible_provider,
    schema: T
): Promise<z.infer<T>> {
    new Notice(`Calling ${provider_name[0].toUpperCase() + provider_name.slice(1)}`);

    // Validate conversation structure
    const validatedConversation = ConversationSchema.parse(conversation);

    if (provider_name === "openrouter") {
        const openrouter_provider = provider as OpenRouterProvider;
        const response = await generateObject({
            model: openrouter_provider.chat(model),
            schema,
            messages: validatedConversation,
            temperature,
            mode: "json",
        });

        return response;
    }

    const final_provider = provider as Exclude<sdk_provider, OpenRouterProvider>;
    const response = await generateObject({
        model: final_provider(model),
        schema,
        messages: validatedConversation,
        temperature,
    });

    return response.object;
}

export async function ai_sdk_image_gen(params: { provider: image_provider; prompt: string; model: string }) {
    // Implementation to be added
    const model = params.model;
    const { image } = await generateImage({
        model: params.provider.image(model),
        prompt: params.prompt,
    });
    const arrayBuffer = image.uint8Array;
    return arrayBuffer;
}

export async function copilot_sdk_streaming(
    client: CopilotClient,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    systemMessage?: string
): Promise<CopilotStreamResult> {
    new Notice("Calling GitHub Copilot");

    // Validate conversation structure
    const validatedConversation = ConversationSchema.parse(conversation);

    const lastUserMessage = validatedConversation.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) {
        throw new Error("No user message found in conversation");
    }

    const session = await client.createSession({
        model: model,
        streaming: true,
        systemMessage: systemMessage ? { content: systemMessage } : undefined,
    });

    const textQueue = new AsyncEventQueue<string>();
    const reasoningQueue = new AsyncEventQueue<string>();
    let cleanedUp = false;

    const performCleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribe();
        try {
            await session.destroy();
        } catch (e) {
            console.warn("Error destroying Copilot session:", e);
        }
    };

    const unsubscribe = session.on((event: any) => {
        // Add runtime checks for event structure
        if (!event || typeof event.type !== 'string') {
            console.warn("Received invalid event from Copilot session:", event);
            return;
        }

        switch (event.type) {
            case "assistant.message_delta":
                if (event.data && typeof event.data.deltaContent === 'string') {
                    textQueue.push(event.data.deltaContent);
                }
                break;
            
            case "assistant.reasoning_delta":
                if (event.data && typeof event.data.deltaContent === 'string') {
                    reasoningQueue.push(event.data.deltaContent);
                }
                break;
            
            case "session.error":
                const errorMessage = event.data?.message || 'Unknown error';
                const error = new Error(`Copilot streaming error: ${errorMessage}`);
                textQueue.fail(error);
                reasoningQueue.fail(error);
                console.error("Copilot session error:", event.data);
                new Notice(`Copilot error: ${errorMessage}`);
                // Perform cleanup when error occurs
                performCleanup().catch(e => console.warn("Error during cleanup after session error:", e));
                break;
            
            case "session.idle":
                textQueue.complete();
                reasoningQueue.complete();
                break;
        }
    });

    try {
        // Send the full conversation history to maintain context
        // Note: Copilot SDK may have specific API for conversation history
        // For now, sending last message as per current API understanding
        await session.send({ prompt: lastUserMessage.content });
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Fail the queues so consumers are not left hanging
        textQueue.fail(error);
        reasoningQueue.fail(error);
        // Clean up the session to avoid resource leaks
        await performCleanup();
        throw error;
    }

    return {
        textStream: textQueue,
        reasoningStream: reasoningQueue,
        session: session,
        abort: () => {
            session.abort();
            textQueue.complete();
            reasoningQueue.complete();
        },
        cleanup: performCleanup
    };
}

export async function copilot_sdk_completion(
    client: CopilotClient,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    systemMessage?: string
): Promise<string> {
    new Notice("Calling GitHub Copilot");

    // Validate conversation structure
    const validatedConversation = ConversationSchema.parse(conversation);

    const lastUserMessage = validatedConversation.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) {
        throw new Error("No user message found in conversation");
    }

    const session = await client.createSession({
        model: model,
        streaming: false,
        systemMessage: systemMessage ? { content: systemMessage } : undefined,
    });

    try {
        // Send the full conversation history to maintain context
        // Note: Copilot SDK may have specific API for conversation history
        // For now, sending last message as per current API understanding
        const response = await session.sendAndWait({ prompt: lastUserMessage.content });
        const content = response?.data?.content || "";
        return content;
    } finally {
        try {
            await session.destroy();
        } catch (e) {
            console.warn("Error destroying Copilot session:", e);
        }
    }
}
