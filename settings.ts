import {
    App,
    Editor,
    MarkdownView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    ItemView,
    WorkspaceLeaf,
    setTooltip,
    setIcon,
    requestUrl,
    debounce,
} from "obsidian";
type ModelDropDownSettings = {
    openai: string;
    groq: string;
    ollama: string;
    anthropic?: string;
    custom?: string; // Make 'custom' optional
    perplexity: string;
};

import { Models, CustomModels, LLMProviderOptions } from "./types";
import CaretPlugin, { DEFAULT_SETTINGS } from "./main";

export class CaretSettingTab extends PluginSettingTab {
    plugin: CaretPlugin;

    constructor(app: App, plugin: CaretPlugin) {
        super(app, plugin);
        this.plugin = plugin;

        // Update streaming setting for Anthropic models
        const default_llm_providers = DEFAULT_SETTINGS.llm_provider_options;
        const current_llm_providers = this.plugin.settings.llm_provider_options;

        if (current_llm_providers.anthropic) {
            for (const [modelKey, modelValue] of Object.entries(default_llm_providers.anthropic)) {
                if (current_llm_providers.anthropic[modelKey]) {
                    current_llm_providers.anthropic[modelKey].streaming = modelValue.streaming;
                }
            }
            // Save the updated settings
            this.plugin.saveSettings();
        }
    }

    api_settings_tab(containerEl: HTMLElement): void {
        // API settings logic here
        const default_llm_providers = DEFAULT_SETTINGS.llm_provider_options;
        const current_llm_providers = this.plugin.settings.llm_provider_options;
        const current_custom = current_llm_providers.custom;

        this.plugin.settings.llm_provider_options = { ...default_llm_providers, custom: { ...current_custom } };

        const custom_endpoints = this.plugin.settings.custom_endpoints;
        // @ts-ignore
        let model_drop_down_settings: ModelDropDownSettings = DEFAULT_SETTINGS.provider_dropdown_options;

        if (Object.keys(custom_endpoints).length > 0) {
            for (const [key, value] of Object.entries(custom_endpoints)) {
                if (value.known_provider) {
                    if (!this.plugin.settings.llm_provider_options[value.known_provider]) {
                        this.plugin.settings.llm_provider_options[value.known_provider] = {};
                    }
                    this.plugin.settings.llm_provider_options[value.known_provider][key] = value;
                } else {
                    this.plugin.settings.llm_provider_options.custom[key] = value;
                }
            }
        }

        let context_window = null;
        try {
            const llm_provider = this.plugin.settings.llm_provider;
            const model = this.plugin.settings.model;
            if (
                this.plugin.settings.llm_provider_options[llm_provider] &&
                this.plugin.settings.llm_provider_options[llm_provider][model]
            ) {
                const model_details = this.plugin.settings.llm_provider_options[llm_provider][model];
                if (model_details && model_details.context_window) {
                    const context_window_value = model_details.context_window;
                    context_window = parseInt(context_window_value.toString());
                }
            }
        } catch (error) {
            console.error("Error retrieving model details:", error);
            context_window = null;
        }
        if (!this.plugin.settings.llm_provider || this.plugin.settings.llm_provider.length === 0) {
            this.plugin.settings.llm_provider = "openai";
            this.plugin.settings.model = "gpt-4-turbo";
            this.plugin.settings.context_window = 128000;
            this.plugin.saveSettings();
        }

        const model_options_data = Object.fromEntries(
            Object.entries(
                this.plugin.settings.llm_provider_options[
                    this.plugin.settings.llm_provider as keyof typeof this.plugin.settings.llm_provider_options
                ]
            ).map(([key, value]) => [key, value.name])
        );

        // LLM Provider Settings
        new Setting(containerEl)
            .setName("LLM provider")
            .setDesc("")
            .addDropdown((dropdown) => {
                dropdown
                    .addOptions(model_drop_down_settings)
                    .setValue(this.plugin.settings.llm_provider)
                    .onChange(async (provider) => {
                        this.plugin.settings.llm_provider = provider;
                        this.plugin.settings.model = Object.keys(
                            this.plugin.settings.llm_provider_options[provider]
                        )[0];
                        this.plugin.settings.context_window =
                            this.plugin.settings.llm_provider_options[provider][
                                this.plugin.settings.model
                            ].context_window;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                        this.display();
                    });
            });
        const setting = new Setting(containerEl).setName("Model").addDropdown((modelDropdown) => {
            modelDropdown.addOptions(model_options_data);
            modelDropdown.setValue(this.plugin.settings.model);
            modelDropdown.onChange(async (value) => {
                this.plugin.settings.model = value;
                this.plugin.settings.context_window =
                    this.plugin.settings.llm_provider_options[this.plugin.settings.llm_provider][value].context_window;
                await this.plugin.saveSettings();
                await this.plugin.loadSettings();
                this.display();
            });
        });
        if (this.plugin.settings.model === "gpt-4o") {
            new Setting(containerEl)
                .setName("GPT-4o")
                .setDesc(
                    "You are are using the new model! If you check errors it might be because your API key doesn't have access."
                );
        }

        if (context_window) {
            setting.setDesc(`FYI your selected model has a context window of ${context_window}`);
        }

        // Image Model Settings

        new Setting(containerEl)
            .setName("Image provider")
            .setDesc("Choose the provider for image generation")
            .addDropdown((dropdown) => {
                dropdown
                    .addOptions(this.plugin.settings.image_provider_dropdown_options)
                    .setValue(this.plugin.settings.image_provider)
                    .onChange(async (provider) => {
                        this.plugin.settings.image_provider = provider;
                        this.plugin.settings.image_model = Object.keys(
                            this.plugin.settings.image_model_options[provider]
                        )[0];
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                        this.display();
                    });
            });

        const image_model_options_data = Object.fromEntries(
            Object.entries(
                this.plugin.settings.image_model_options[
                    this.plugin.settings.image_provider as keyof typeof this.plugin.settings.image_model_options
                ]
            ).map(([key, value]) => [key, value.name])
        );

        const imageModelSetting = new Setting(containerEl).setName("Image model").addDropdown((modelDropdown) => {
            modelDropdown.addOptions(image_model_options_data);
            modelDropdown.setValue(this.plugin.settings.image_model);
            modelDropdown.onChange(async (value) => {
                this.plugin.settings.image_model = value;
                await this.plugin.saveSettings();
                await this.plugin.loadSettings();
                this.display();
            });
        });

        // Show supported sizes for the selected image model
        const selectedImageModel =
            this.plugin.settings.image_model_options[this.plugin.settings.image_provider][
                this.plugin.settings.image_model
            ];
        // if (selectedImageModel && selectedImageModel.supported_sizes) {
        //     imageModelSetting.setDesc(`Supported sizes: ${selectedImageModel.supported_sizes.join(", ")}`);
        // }
        if (this.plugin.settings.llm_provider === "ollama") {
            const ollama_info_container = containerEl.createEl("div", {
                cls: "caret-settings_container",
            });
            ollama_info_container.createEl("strong", { text: "You're using Ollama!" });
            ollama_info_container.createEl("p", { text: "Remember to do the following:" });
            ollama_info_container.createEl("p", { text: "Make sure you have downloaded the model you want to use:" });
            const second_code_block_container = ollama_info_container.createEl("div", {
                cls: "caret-settings_code_block",
            });

            second_code_block_container.createEl("code", { text: `ollama run ${this.plugin.settings.model}` });
            ollama_info_container.createEl("p", {
                text: "After running the model, kill that command and close the ollama app.",
            });
            ollama_info_container.createEl("p", {
                text: "Then run this command to start the Ollama server and make it accessible from Obsidian:",
            });
            const code_block_container = ollama_info_container.createEl("div", {
                cls: "caret-settings_code_block",
            });
            code_block_container.createEl("code", {
                text: "OLLAMA_ORIGINS=app://obsidian.md* ollama serve",
            });

            ollama_info_container.createEl("br"); // Adds a line break for spacing
        }

        new Setting(containerEl)
            .setName("OpenAI API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("OpenAI API key")
                    .setValue(this.plugin.settings.openai_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.openai_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });

        new Setting(containerEl)
            .setName("Groq API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("Groq API key")
                    .setValue(this.plugin.settings.groq_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.groq_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });
        new Setting(containerEl)
            .setName("Anthropic API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("Anthropic API key")
                    .setValue(this.plugin.settings.anthropic_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.anthropic_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });
        new Setting(containerEl)
            .setName("OpenRouter API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("OpenRouter API key")
                    .setValue(this.plugin.settings.open_router_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.open_router_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });

        new Setting(containerEl)
            .setName("Google Gemini API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("Google Gemini API key")
                    .setValue(this.plugin.settings.google_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.google_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });

        new Setting(containerEl)
            .setName("Perplexity API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("Perplexity API key")
                    .setValue(this.plugin.settings.perplexity_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.perplexity_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });

        new Setting(containerEl)
            .setName("xAI API key")
            .setDesc("")
            .addText((text) => {
                text.setPlaceholder("xAI API key")
                    .setValue(this.plugin.settings.xai_api_key)
                    .onChange(async (value: string) => {
                        this.plugin.settings.xai_api_key = value;
                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
                text.inputEl.addClass("caret-hidden-value-unsecure");
            });

        // GitHub Copilot Section
        containerEl.createEl("h3", { text: "GitHub Copilot" });

        new Setting(containerEl)
            .setName("Enable GitHub Copilot")
            .setDesc("Use your GitHub Copilot subscription as an LLM provider (no API key required)")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.github_copilot_enabled).onChange(async (value: boolean) => {
                    this.plugin.settings.github_copilot_enabled = value;
                    await this.plugin.saveSettings();
                    
                    // Restart client when toggled
                    if (this.plugin.restartCopilotClient) {
                        await this.plugin.restartCopilotClient();
                    }
                    
                    this.display(); // Refresh to show/hide instructions
                });
            });

        // Show setup instructions and status when Copilot is enabled
        if (this.plugin.settings.github_copilot_enabled) {
            // CLI Status indicator
            const statusContainer = containerEl.createEl("div", {
                cls: "caret-settings_container",
            });
            
            const statusEl = statusContainer.createEl("p", { text: "Checking Copilot CLI status..." });
            
            // Async status check using the plugin's checkCopilotCLI method
            this.plugin.checkCopilotCLI().then((status) => {
                if (status.installed && status.authenticated) {
                    statusEl.setText(`✅ GitHub CLI ready${status.version ? ` (${status.version})` : ''}`);
                    statusEl.addClass("caret-status-success");
                } else if (status.installed && !status.authenticated) {
                    statusEl.setText("⚠️ GitHub CLI installed but not authenticated");
                    statusEl.addClass("caret-status-warning");
                } else {
                    statusEl.setText("❌ GitHub CLI not found");
                    statusEl.addClass("caret-status-error");
                }
            });

            // Setup Instructions
            const instructionsContainer = containerEl.createEl("div", {
                cls: "caret-settings_container",
            });
            
            instructionsContainer.createEl("h4", { text: "Setup Instructions" });
            
            const stepsList = instructionsContainer.createEl("ol");
            
            const step1 = stepsList.createEl("li");
            step1.createEl("span", { text: "Install GitHub CLI: " });
            step1.createEl("a", { 
                text: "https://cli.github.com", 
                href: "https://cli.github.com",
                attr: { target: "_blank" }
            });
            
            stepsList.createEl("li", { text: "Run 'gh auth login' in terminal to authenticate" });
            
            const step3 = stepsList.createEl("li");
            step3.createEl("span", { text: "Install Copilot extension: " });
            const codeBlock = step3.createEl("div", { cls: "caret-settings_code_block" });
            codeBlock.createEl("code", { text: "gh extension install github/gh-copilot" });
            
            stepsList.createEl("li", { text: "Enable the toggle above and select GitHub Copilot as your provider" });
            
            // Troubleshooting section
            const troubleContainer = containerEl.createEl("div", {
                cls: "caret-settings_container",
            });
            troubleContainer.createEl("h4", { text: "Troubleshooting" });
            
            const troubleList = troubleContainer.createEl("ul");
            troubleList.createEl("li", { text: "If authentication expires, run 'gh auth refresh'" });
            troubleList.createEl("li", { text: "Restart Obsidian after installing GitHub CLI" });
            troubleList.createEl("li", { text: "Check console (Ctrl+Shift+I) for detailed error logs" });

            // Custom CLI Path setting
            new Setting(containerEl)
                .setName("Custom CLI Path")
                .setDesc("Optional: specify a custom path to the GitHub CLI (gh) executable")
                .addText((text) => {
                    text.setPlaceholder("gh")
                        .setValue(this.plugin.settings.github_copilot_cli_path || "")
                        .onChange(async (value: string) => {
                            this.plugin.settings.github_copilot_cli_path = value || undefined;
                            await this.plugin.saveSettings();
                        });
                });
        }

        new Setting(containerEl)
            .setName("Reload after adding API keys!")
            .setDesc(
                "After you added API keys for the first time you will need to reload the plugin for those changes to take effect. \n This only needs to be done the first time or when you change your keys."
            );
    }
    chat_settings_tab(containerEl: HTMLElement): void {
        let tempChatFolderPath = this.plugin.settings.chat_logs_folder; // Temporary storage for input value

        const debouncedSave = debounce(
            async (value: string) => {
                if (value.length <= 1) {
                    new Notice("The folder path must be longer than one character.");
                    return;
                }
                if (value.endsWith("/")) {
                    new Notice("The folder path must not end with a trailing slash.");
                    return;
                }
                if (value !== this.plugin.settings.chat_logs_folder) {
                    this.plugin.settings.chat_logs_folder = value;
                    await this.plugin.saveSettings();
                    await this.plugin.loadSettings();
                }
            },
            1000,
            true
        ); // 500ms delay

        new Setting(containerEl)
            .setName("Chat folder path")
            .setDesc("Specify the folder path where chat logs will be stored.")
            .addText((text) => {
                text.setPlaceholder("Enter folder path")
                    .setValue(this.plugin.settings.chat_logs_folder)
                    .onChange((value: string) => {
                        tempChatFolderPath = value;
                        debouncedSave(value);
                    });
            });

        new Setting(containerEl)
            .setName("Use date format for subfolders")
            .setDesc("Use Year-Month-Date as subfolders for the chat logs.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.chat_logs_date_format_bool).onChange(async (value: boolean) => {
                    this.plugin.settings.chat_logs_date_format_bool = value;
                    await this.plugin.saveSettings();
                    await this.plugin.loadSettings();
                });
            });

        new Setting(containerEl)
            .setName("Rename chats")
            .setDesc("Chats will be given a descriptive name using your default set provider/model")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.chat_logs_rename_bool).onChange(async (value: boolean) => {
                    this.plugin.settings.chat_logs_rename_bool = value;
                    await this.plugin.saveSettings();
                    await this.plugin.loadSettings();
                });
            });

        // LLM Provider Settings
        const send_chat_shortcut_options: { [key: string]: string } = {
            enter: "Enter",
            shift_enter: "Shift + Enter",
            // cmd_enter: "CMD + Enter",
        };
        new Setting(containerEl)
            .setName("Send chat keybinds")
            .setDesc("Select which shortcut will be used to send messages.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOptions(send_chat_shortcut_options)
                    .setValue(this.plugin.settings.chat_send_chat_shortcut)
                    .onChange(async (selected) => {
                        this.plugin.settings.chat_send_chat_shortcut = selected;

                        await this.plugin.saveSettings();
                        await this.plugin.loadSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Use nested [[]] content")
            .setDesc("When set to true, context will include 1 layer of block refs")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.include_nested_block_refs).onChange(async (value: boolean) => {
                    this.plugin.settings.include_nested_block_refs = value;
                    await this.plugin.saveSettings();
                    await this.plugin.loadSettings();
                });
            });
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        if (this.plugin.settings.caret_version !== DEFAULT_SETTINGS.caret_version) {
            this.plugin.settings.caret_version = DEFAULT_SETTINGS.caret_version;
        }

        const tabContainer = containerEl.createEl("div", { cls: "caret-tab-container" });
        const apiTab = tabContainer.createEl("button", { text: "LLM APIs ", cls: "caret-tab" });
        const chatTab = tabContainer.createEl("button", { text: "Chat", cls: "caret-tab" });

        const apiSettingsContainer = containerEl.createEl("div", { cls: "caret-api-settings-container caret-hidden" });
        const chatSettingsContainer = containerEl.createEl("div", {
            cls: "caret-chat-settings-container caret-hidden",
        });

        this.api_settings_tab(apiSettingsContainer);
        this.chat_settings_tab(chatSettingsContainer);

        // LLM Provider Settings
        new Setting(containerEl).setDesc(`Caret Version: ${this.plugin.settings.caret_version}`);

        apiTab.addEventListener("click", () => {
            apiSettingsContainer.classList.remove("caret-hidden");
            chatSettingsContainer.classList.add("caret-hidden");
        });

        chatTab.addEventListener("click", () => {
            chatSettingsContainer.classList.remove("caret-hidden");
            apiSettingsContainer.classList.add("caret-hidden");
            // Placeholder for chat settings rendering function
            // this.chat_settings_tab(chatSettingsContainer);
        });

        // Initially load API settings tab
        apiTab.click();

        // this.api_settings_tab(containerEl);
    }
}
