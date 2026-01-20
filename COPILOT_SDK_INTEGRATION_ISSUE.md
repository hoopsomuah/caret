# Feature Request: Integrate GitHub Copilot SDK as an LLM Provider

## Summary

Add GitHub Copilot SDK (`@github/copilot-sdk`) as a new LLM provider option in Caret, enabling users with GitHub Copilot subscriptions to leverage Copilot's AI capabilities directly within their Obsidian vault.

## Background

GitHub has released the [Copilot CLI SDK](https://github.com/github/copilot-sdk) in technical preview. This SDK provides programmatic access to GitHub Copilot's agentic AI capabilities through language-specific SDKs (Node.js, Python, Go, .NET).

### Key SDK Features

- **Multi-turn conversations**: Session-based API that maintains conversation history
- **Streaming support**: Real-time response streaming with `assistant.message_delta` events
- **Custom tools**: Ability to define custom tools that Copilot can invoke during conversations
- **Multiple model support**: Access to models like `gpt-5`, `claude-sonnet-4.5`, etc.
- **System message customization**: Ability to customize system prompts
- **File attachments**: Support for file context in conversations

## Proposed Integration

### 1. Add `@github/copilot-sdk` as a dependency

```bash
npm install @github/copilot-sdk
```

**Note**: The SDK requires Node.js >= 18.0.0 and the GitHub Copilot CLI to be installed.

### 2. Create a new provider in `llm_calls.ts`

Add `github-copilot` as a new eligible provider:

```typescript
export type eligible_provider =
    | "google"
    | "openai"
    | "anthropic"
    | "groq"
    | "ollama"
    | "openrouter"
    | "custom"
    | "perplexity"
    | "github-copilot"; // NEW
```

### 3. Implement Copilot client initialization in `main.ts`

```typescript
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";

// In CaretPlugin class
copilot_client: CopilotClient | null = null;
copilot_session: CopilotSession | null = null;

// In onload()
if (this.settings.github_copilot_enabled) {
    this.copilot_client = new CopilotClient({
        autoStart: true,
        autoRestart: true,
    });
    await this.copilot_client.start();
}
```

### 4. Implement streaming and completion functions

The SDK uses an event-based model for streaming:

```typescript
export async function copilot_sdk_streaming(
    client: CopilotClient,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    systemMessage?: string
): Promise<{ session: CopilotSession; textStream: AsyncIterable<string> }> {
    const session = await client.createSession({
        model: model,
        streaming: true,
        systemMessage: systemMessage ? { content: systemMessage } : undefined,
    });
    
    // Create an async queue for streaming chunks
    const chunks: string[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    
    session.on((event) => {
        if (event.type === "assistant.message_delta") {
            chunks.push(event.data.deltaContent);
            resolveNext?.();
        } else if (event.type === "session.idle") {
            done = true;
            resolveNext?.();
        }
    });
    
    // Send the last user message
    const lastUserMessage = conversation.filter(m => m.role === 'user').pop();
    if (lastUserMessage) {
        await session.send({ prompt: lastUserMessage.content });
    }
    
    // Return an async iterable that yields text chunks
    const textStream = {
        async *[Symbol.asyncIterator]() {
            while (!done || chunks.length > 0) {
                if (chunks.length > 0) {
                    yield chunks.shift()!;
                } else if (!done) {
                    await new Promise<void>(resolve => { resolveNext = resolve; });
                }
            }
        }
    };
    
    return { session, textStream };
}

// Alternative: Use sendAndWait for non-streaming completion
export async function copilot_sdk_completion(
    client: CopilotClient,
    model: string,
    conversation: Array<{ role: string; content: string }>,
    systemMessage?: string
): Promise<string> {
    const session = await client.createSession({
        model: model,
        systemMessage: systemMessage ? { content: systemMessage } : undefined,
    });
    
    const lastUserMessage = conversation.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) {
        throw new Error("No user message in conversation");
    }
    
    const response = await session.sendAndWait({ prompt: lastUserMessage.content });
    const content = response?.data?.content || "";
    
    await session.destroy();
    return content;
}
```

### 5. Update settings

Add new settings in `types.ts` and `settings.ts`:

```typescript
// In CaretPluginSettings
github_copilot_enabled: boolean;
github_copilot_cli_path?: string; // Optional custom path to Copilot CLI
```

Add to `DEFAULT_SETTINGS`:

```typescript
github_copilot_enabled: false,
llm_provider_options: {
    // ... existing providers
    "github-copilot": {
        "gpt-5": {
            name: "GPT-5 (via Copilot)",
            context_window: 400000,
            function_calling: true,
            vision: true,
            streaming: true,
        },
        "claude-sonnet-4.5": {
            name: "Claude Sonnet 4.5 (via Copilot)",
            context_window: 200000,
            function_calling: true,
            vision: true,
            streaming: true,
        },
    },
},
provider_dropdown_options: {
    // ... existing options
    "github-copilot": "GitHub Copilot",
},
```

### 6. Update settings UI

Add a toggle for GitHub Copilot in `settings.ts`:

```typescript
new Setting(containerEl)
    .setName("Enable GitHub Copilot")
    .setDesc("Use GitHub Copilot SDK as an LLM provider (requires Copilot CLI installed)")
    .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.github_copilot_enabled)
            .onChange(async (value: boolean) => {
                this.plugin.settings.github_copilot_enabled = value;
                await this.plugin.saveSettings();
            });
    });
```

## Implementation Considerations

### Advantages

1. **No API keys required**: Users with GitHub Copilot subscriptions don't need separate API keys
2. **Access to latest models**: Direct access to GPT-5, Claude Sonnet 4.5, and other models through Copilot
3. **GitHub integration**: Potential for deeper integration with GitHub repositories and context
4. **Tool support**: Ability to create custom tools that Copilot can invoke
5. **Agent Skills**: Potential to leverage Copilot's Agent Skills feature for custom workflows

### Challenges

1. **External dependency**: Requires GitHub Copilot CLI to be installed and in PATH
2. **Authentication**: Relies on Copilot CLI authentication (GitHub login)
3. **Technical preview**: SDK is still in technical preview and may have breaking changes
4. **Platform compatibility**: Need to ensure compatibility with Obsidian's sandboxed environment
5. **Process management**: The SDK spawns a CLI process that needs proper lifecycle management

### Compatibility with Caret's Design Principles

| Principle | Compatibility | Notes |
|-----------|---------------|-------|
| Local-first | ✅ | Copilot CLI runs locally |
| No external services (except LLM providers) | ✅ | Copilot is an LLM provider |
| Data stored as markdown files | ✅ | No change to data storage |

## Suggested Implementation Phases

### Phase 1: Basic Integration
- [ ] Add SDK dependency
- [ ] Implement basic completion functionality
- [ ] Add settings UI toggle
- [ ] Test with single-turn conversations

### Phase 2: Streaming Support
- [ ] Implement streaming responses
- [ ] Integrate with canvas node streaming
- [ ] Handle streaming events properly

### Phase 3: Advanced Features
- [ ] Add file attachment support (for vault files as context)
- [ ] Implement custom tools for Obsidian-specific operations
- [ ] Add session management for multi-turn conversations

### Phase 4: Error Handling & UX
- [ ] Add graceful fallback when Copilot CLI is not available
- [ ] Implement proper error messages and notifications
- [ ] Add setup instructions in settings UI

## Prerequisites for Users

To use this integration, users will need:

1. A GitHub Copilot subscription (Individual, Business, or Enterprise)
2. GitHub Copilot CLI installed: Follow the [installation guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)
3. Authenticated with GitHub via Copilot CLI

## Related Links

- [GitHub Copilot SDK Repository](https://github.com/github/copilot-sdk)
- [Node.js SDK README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Copilot CLI Features](https://github.com/features/copilot/cli/)
- [Copilot SDK Technical Preview Announcement](https://github.blog/changelog/2026-01-14-copilot-sdk-in-technical-preview/)

## Questions for Discussion

1. Should we wait for the SDK to exit technical preview before integrating?
2. How should we handle the Copilot CLI process lifecycle within Obsidian's environment?
3. Should we implement custom tools that integrate with Obsidian's vault functionality?
4. What's the best way to provide setup instructions for users who need to install Copilot CLI?

---

**Labels**: enhancement, feature-request, llm-integration

**Assignees**: TBD

**Milestone**: Future Release
