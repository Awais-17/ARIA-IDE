const OpenAI = require('openai');
const Groq = require('groq-sdk');
const axios = require('axios');

class AIService {
    constructor(config) {
        this.updateConfig(config);
    }

    updateConfig(config) {
        this.config = config || {};
        this.activeAbortController = null;

        // ── Built-in named clients ──────────────────────────────────────────
        this.openai = this.config.openaiApiKey
            ? new OpenAI({ apiKey: this.config.openaiApiKey, maxRetries: 0 })
            : null;

        this.groq = this.config.groqApiKey
            ? new Groq({ apiKey: this.config.groqApiKey })
            : null;

        this.nvidiaCloud = this.config.ngcApiKey
            ? new OpenAI({
                baseURL: 'https://integrate.api.nvidia.com/v1',
                apiKey: this.config.ngcApiKey,
                maxRetries: 0,
              })
            : null;

        const openRouterKey =
            this.config.openRouterKeys?.openrouter || this.config.openRouterApiKey;
        this.openRouterClient = openRouterKey
            ? new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey: openRouterKey,
                maxRetries: 0,
                defaultHeaders: {
                    'HTTP-Referer': 'https://aria-code.ai',
                    'X-Title': 'ARIA',
                },
              })
            : null;

        this.openRouterClients = {};
        if (this.config.openRouterKeys) {
            Object.entries(this.config.openRouterKeys).forEach(([keyName, apiKey]) => {
                if (apiKey) {
                    this.openRouterClients[keyName] = new OpenAI({
                        baseURL: 'https://openrouter.ai/api/v1',
                        apiKey,
                        maxRetries: 0,
                        defaultHeaders: {
                            'HTTP-Referer': 'https://aria-code.ai',
                            'X-Title': 'ARIA',
                        },
                    });
                }
            });
        }

        this.localClient = new OpenAI({
            baseURL: this.config.localBaseUrl || 'http://127.0.0.1:11434/v1',
            apiKey: this.config.localApiKey || 'not-needed',
            maxRetries: 0,
        });

        // ── Custom provider clients (OpenAI-compatible) ─────────────────────
        this.customClients = {};
        // Providers that use their own non-OpenAI protocol — skip building an
        // OpenAI wrapper for them; they are handled with dedicated methods.
        const NON_OPENAI_PROVIDERS = new Set(['anthropic']);

        if (this.config.customProviders) {
            this.config.customProviders.forEach(provider => {
                if (provider.baseUrl && !NON_OPENAI_PROVIDERS.has(provider.id)) {
                    this.customClients[provider.id] = new OpenAI({
                        baseURL: provider.baseUrl,
                        apiKey: provider.apiKey || 'not-needed',
                        maxRetries: 0,
                    });
                }
            });

            // Bridge well-known providers to their native clients
            const pick = (id) =>
                this.config.customProviders.find(p => p.id === id);

            const anthropicProvider = pick('anthropic');
            if (anthropicProvider?.apiKey) {
                this.config.anthropicApiKey = anthropicProvider.apiKey;
            }

            const openaiProvider = pick('openai');
            if (openaiProvider?.apiKey) {
                this.openai = new OpenAI({ apiKey: openaiProvider.apiKey, maxRetries: 0 });
            }

            const groqProvider = pick('groq');
            if (groqProvider?.apiKey) {
                this.groq = new Groq({ apiKey: groqProvider.apiKey });
            }

            const openrouterProvider = pick('openrouter');
            if (openrouterProvider?.apiKey) {
                this.openRouterClient = new OpenAI({
                    baseURL: openrouterProvider.baseUrl || 'https://openrouter.ai/api/v1',
                    apiKey: openrouterProvider.apiKey,
                    maxRetries: 0,
                    defaultHeaders: {
                        'HTTP-Referer': 'https://aria-code.ai',
                        'X-Title': 'ARIA',
                    },
                });
            }

            const nvidiaProvider = pick('nvidia');
            if (nvidiaProvider?.apiKey) {
                this.nvidiaCloud = new OpenAI({
                    baseURL: nvidiaProvider.baseUrl || 'https://integrate.api.nvidia.com/v1',
                    apiKey: nvidiaProvider.apiKey,
                    maxRetries: 0,
                });
            }
        }

        // ── Static model → client mappings ──────────────────────────────────
        this.modelMapping = {
            'gpt-4o':                                   { client: this.openai,        provider: 'openai'      },
            'gpt-4o-mini':                              { client: this.openai,        provider: 'openai'      },
            'llama-3.3-70b-versatile':                  { client: this.groq,          provider: 'groq'        },
            'mistralai/mistral-medium-3.5-128b':        { client: this.nvidiaCloud,   provider: 'nvidia'      },
            'nvidia/phi-3.5-vision-instruct':           { client: this.nvidiaCloud,   provider: 'nvidia'      },
            'nvidia/nemotron-3-super-120b-a12b:free':   { client: this.openRouterClients.nvidia   || this.openRouterClient, provider: 'openrouter' },
            'openai/gpt-oss-120b:free':                 { client: this.openRouterClients.gptOss   || this.openRouterClient, provider: 'openrouter' },
            'google/gemma-4-31b-it:free':               { client: this.openRouterClients.gemma    || this.openRouterClient, provider: 'openrouter' },
            'meta-llama/llama-3.3-70b-instruct:free':   { client: this.openRouterClients.llama    || this.openRouterClient, provider: 'openrouter' },
        };

        if (this.config.localModel) {
            this.modelMapping[this.config.localModel] = {
                client: this.localClient,
                provider: 'local',
            };
        }

        // Dynamic mappings from connected custom providers
        if (this.config.customProviders) {
            this.config.customProviders.forEach(provider => {
                if (provider.models) {
                    provider.models.forEach(modelName => {
                        // Filter out non-chat models
                        if (!this._isChatModel(modelName)) return;

                        // Anthropic models are routed via runAnthropic(), not an OpenAI client
                        if (provider.id === 'anthropic') {
                            this.modelMapping[modelName] = {
                                client: null,
                                provider: 'anthropic',
                            };
                        } else {
                            this.modelMapping[modelName] = {
                                client: this.customClients[provider.id],
                                provider: provider.id,
                            };
                        }
                    });
                }
            });
        }

        // ── Smart-mode fallback sequence (only models with a client) ─────────
        const candidateFallbacks = [
            'gpt-4o',
            'llama-3.3-70b-versatile',
            'mistralai/mistral-medium-3.5-128b',
            'nvidia/phi-3.5-vision-instruct',
            'meta-llama/llama-3.3-70b-instruct:free',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'openai/gpt-oss-120b:free',
            'google/gemma-4-31b-it:free',
        ];

        if (this.config.localModel) {
            candidateFallbacks.unshift(this.config.localModel);
        }

        // Add all custom-provider models first (user-configured = highest priority)
        const customModelIds = [];
        if (this.config.customProviders) {
            this.config.customProviders.forEach(provider => {
                if (provider.models) {
                    provider.models.forEach(m => {
                        if (this._isChatModel(m)) {
                            customModelIds.push(m);
                        }
                    });
                }
            });
        }

        // Filter to only models that actually have a working client
        this.fallbackSequence = [
            ...customModelIds,
            ...candidateFallbacks,
        ].filter(modelName => this._hasClientForModel(modelName));

        // Deduplicate
        this.fallbackSequence = [...new Set(this.fallbackSequence)];

        // ── Apply user-defined model priorities ─────────────────────────────
        this.modelPriorities = this.config.modelPriorities || {};
        if (Object.keys(this.modelPriorities).length > 0) {
            this.fallbackSequence.sort((a, b) => {
                const pa = this.modelPriorities[a] ?? 999;
                const pb = this.modelPriorities[b] ?? 999;
                return pa - pb;
            });
        }

        // Default model — prefer first working model if default has no client
        this.currentModel = this.config.defaultModel || 'gpt-4o';
        if (this.fallbackSequence.length > 0 && !this._hasClientForModel(this.currentModel)) {
            this.currentModel = this.fallbackSequence[0];
        }
    }

    cancelActiveRequest() {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
            console.log("Active AI request aborted by user.");
            return true;
        }
        return false;
    }

    /**
     * Returns true if a model is a chat/text-completion model, not a utility model.
     */
    _isChatModel(modelName) {
        if (!modelName || typeof modelName !== 'string') return false;
        const id = modelName.toLowerCase();
        const nonChatKeywords = [
            'whisper',
            'embed',
            'bge-',
            'similarity',
            'clip',
            'diffusion',
            'detector',
            'guard',
            'moderation',
            'safety',
            'tts',
            'reward',
            'deplot',
            'parse',
            'riva-translate',
            'rerank',
            'kosmos'
        ];
        return !nonChatKeywords.some(keyword => id.includes(keyword));
    }

    /**
     * Returns true if a client (or special handler) is available for this model.
     */
    _hasClientForModel(modelName) {
        // Only allow chat models
        if (!this._isChatModel(modelName)) return false;

        // Anthropic models are always handled natively if key is present
        if (
            modelName.startsWith('claude-') ||
            (this.modelMapping[modelName]?.provider === 'anthropic')
        ) {
            return !!this.config.anthropicApiKey;
        }

        const mapping = this.modelMapping[modelName];
        if (mapping?.client) return true;

        // GPT → OpenAI client
        if (modelName.startsWith('gpt-')) return !!this.openai;

        // Check custom providers
        if (this.config.customProviders) {
            const baseModelName = modelName.replace(/:free$/, '');
            const found = this.config.customProviders.find(
                p => p.models && (p.models.includes(modelName) || p.models.includes(baseModelName))
            );
            if (found) return !!this.customClients[found.id];
        }

        // OpenRouter fallback
        if (this.openRouterClient) return true;

        return false;
    }

    /**
     * Classifies a user prompt into a task category for intelligent model routing.
     */
    _classifyTask(prompt) {
        const p = prompt.toLowerCase();
        const len = prompt.trim().length;

        // Reasoning / analysis tasks
        const reasoningPatterns = [
            /\bwhy\b/, /\bexplain\b/, /\banalyze\b/, /\bdebug\b/, /\bthink.*step/,
            /\breason\b/, /\bcompare\b/, /\btrade.?off/, /\barchitect/,
            /\bdesign.*system/, /\boptimize\b/, /\brefactor\b/, /\breview.*code/,
            /\bwhat.*wrong/, /\bwhat.*cause/, /\bdiagnos/
        ];
        if (reasoningPatterns.some(rx => rx.test(p))) return 'reasoning';

        // Coding / implementation tasks
        const codingPatterns = [
            /\bcreate\b/, /\bbuild\b/, /\bimplement\b/, /\bwrite.*code/,
            /\badd.*feature/, /\badd.*function/, /\b\[file:/i, /\bgenerate\b/,
            /\bscaffold\b/, /\bsetup\b/, /\bmake.*app/, /\bmake.*page/,
            /\bmake.*component/, /\bmake.*api/, /\bintegrate\b/, /\bcrud\b/,
            /\bwebsite\b/, /\bdashboard\b/, /\bform\b/, /\blogin\b/
        ];
        if (codingPatterns.some(rx => rx.test(p))) return 'coding';

        // Quick / simple tasks
        if (len < 40) return 'quick';
        const quickPatterns = [
            /\bfix.*this/, /\brename\b/, /\bformat\b/, /\badd.*comment/,
            /\btypo\b/, /\bsyntax/, /\bimport\b/
        ];
        if (quickPatterns.some(rx => rx.test(p))) return 'quick';

        // Creative / brainstorming tasks
        const creativePatterns = [
            /\bsuggest\b/, /\bbrainstorm\b/, /\bidea/, /\bname\b/,
            /\bdesign\b/, /\bui\b/, /\bux\b/, /\blogo\b/
        ];
        if (creativePatterns.some(rx => rx.test(p))) return 'creative';

        return 'coding'; // default for a code editor
    }

    /**
     * Known model traits — maps model name patterns to task affinity scores.
     */
    _getModelTraits(modelName) {
        if (!modelName) return { reasoning: 5, coding: 5, quick: 5, creative: 5 };
        const m = modelName.toLowerCase();
        
        // Strip provider prefix if any (e.g. "nvidia/llama-3.3-70b-instruct" -> "llama-3.3-70b-instruct")
        let baseName = m;
        if (baseName.includes('/')) {
            baseName = baseName.split('/').pop();
        }
        if (baseName.includes(':')) {
            baseName = baseName.split(':')[0];
        }

        const traits = { reasoning: 5, coding: 5, quick: 5, creative: 5 };

        // 1. REASONING CLASSIFICATION (Deep reasoning / thinking models)
        if (
            baseName.includes('r1') ||
            baseName.includes('reasoner') ||
            baseName.includes('reasoning') ||
            baseName.startsWith('o1') ||
            baseName.startsWith('o3') ||
            baseName.startsWith('o4')
        ) {
            traits.reasoning = 10;
            traits.coding = 7;
            traits.quick = 2;
            traits.creative = 5;
        }
        // 2. CODING SPECIALISTS
        else if (
            baseName.includes('coder') ||
            baseName.includes('codestral') ||
            baseName.includes('starcoder')
        ) {
            traits.reasoning = 5;
            traits.coding = 10;
            traits.quick = 6;
            traits.creative = 3;
        }
        // 3. HIGH-END FRONTIER MODELS (Grok, Claude Sonnet/Opus, GPT-4o, Gemini Pro)
        else if (baseName.includes('grok')) {
            traits.reasoning = 8.5;
            traits.coding = 8.5;
            traits.quick = 5;
            traits.creative = 8.5;
        }
        else if (baseName.includes('opus')) {
            traits.reasoning = 9;
            traits.coding = 9;
            traits.quick = 3;
            traits.creative = 9;
        }
        else if (baseName.includes('sonnet')) {
            traits.reasoning = 8;
            traits.coding = 9;
            traits.quick = 5;
            traits.creative = 8;
        }
        else if (baseName.includes('gpt-4o') && !baseName.includes('mini')) {
            traits.reasoning = 8.5;
            traits.coding = 9;
            traits.quick = 5;
            traits.creative = 8.5;
        }
        else if (baseName.includes('gemini') && baseName.includes('pro')) {
            traits.reasoning = 8.5;
            traits.coding = 8.5;
            traits.quick = 5;
            traits.creative = 9;
        }
        else if (baseName.includes('nemotron-4') || baseName.includes('nemotron-3-super')) {
            traits.reasoning = 8;
            traits.coding = 7.5;
            traits.quick = 4;
            traits.creative = 7;
        }
        else if (baseName.includes('mistral-large') || baseName.includes('mixtral-8x22b')) {
            traits.reasoning = 8;
            traits.coding = 8.5;
            traits.quick = 4;
            traits.creative = 7.5;
        }
        else if (baseName.includes('llama-3.1-405b') || baseName.includes('llama-3-70b') || baseName.includes('llama-3.1-70b') || baseName.includes('llama-3.3-70b')) {
            traits.reasoning = 8;
            traits.coding = 8;
            traits.quick = 4;
            traits.creative = 7.5;
        }
        else if (baseName.includes('qwen') && (baseName.includes('72b') || baseName.includes('max') || baseName.includes('plus'))) {
            traits.reasoning = 8;
            traits.coding = 8.5;
            traits.quick = 4;
            traits.creative = 7;
        }
        else if (baseName.includes('glm-5.1') || baseName.includes('glm-4-plus')) {
            traits.reasoning = 8;
            traits.coding = 8;
            traits.quick = 4;
            traits.creative = 7;
        }

        // 4. SMALL / LIGHTWEIGHT / FLASH / HAIKU MODELS (Optimized for speed/simple tasks)
        if (
            baseName.includes('mini') ||
            baseName.includes('flash') ||
            baseName.includes('haiku') ||
            baseName.includes('phi') ||
            baseName.includes('gemma') ||
            baseName.includes('8b') ||
            baseName.includes('9b') ||
            baseName.includes('7b') ||
            baseName.includes('14b') ||
            baseName.includes('3b') ||
            baseName.includes('1b') ||
            baseName.includes('nano')
        ) {
            // These models are exceptionally good at quick, cheap tasks
            traits.quick = 10;
            // Scale down reasoning/coding scores slightly if they aren't already categorized
            if (traits.reasoning === 5) traits.reasoning = 5;
            if (traits.coding === 5) traits.coding = 5.5;
        }

        return traits;
    }

    /**
     * Returns the best available model for the given prompt.
     * Smart mode: classifies the task and scores models accordingly.
     * Priority mode: respects user-defined ordering within the same score tier.
     */
    _getBestAvailableModel(prompt = '') {
        if (this.fallbackSequence.length === 0) return 'gpt-4o';
        if (!prompt) return this.fallbackSequence[0];

        const category = this._classifyTask(prompt);
        console.log(`[Smart Mode] Task classified as: ${category}`);

        let bestModel = this.fallbackSequence[0];
        let bestScore = -1;

        for (const modelName of this.fallbackSequence) {
            const traits = this._getModelTraits(modelName);
            const score = traits[category] || 5;
            // Use priority as tiebreaker (lower priority number = preferred)
            const priority = this.modelPriorities?.[modelName] ?? 999;
            const adjustedScore = score * 1000 - priority; // higher is better

            if (adjustedScore > bestScore) {
                bestScore = adjustedScore;
                bestModel = modelName;
            }
        }

        console.log(`[Smart Mode] Selected model: ${bestModel} (category: ${category})`);
        return bestModel;
    }

    setModel(modelId) {
        this.currentModel = modelId;
    }

    /**
     * Generates text embeddings. Gracefully skips if no OpenAI client.
     */
    async getEmbeddings(text) {
        if (!this.openai) {
            // Return empty vector — indexing is optional
            return [];
        }
        try {
            const response = await this.openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
            });
            return response.data[0].embedding;
        } catch (error) {
            console.error('Embedding Error:', error);
            return [];
        }
    }

    async askAI(
        prompt,
        currentFileContent,
        fileStructure,
        mode = 'chat',
        modelId = null,
        repoMap = null,
        relevantSnippets = [],
        conversationHistory = []
    ) {
        // Cooperative Agent Flow
        if (modelId && typeof modelId === 'object' && modelId.planner) {
            return this.cooperativeWorkflow(
                prompt, currentFileContent, fileStructure,
                repoMap, relevantSnippets, modelId, conversationHistory
            );
        }

        if (mode === 'chat' && (modelId === 'smart' || !modelId)) {
            return this.agenticWorkflow(
                prompt, currentFileContent, fileStructure, repoMap, relevantSnippets, conversationHistory
            );
        }

        return this.executeDirect(
            prompt, currentFileContent, fileStructure, mode, modelId, repoMap, relevantSnippets, conversationHistory
        );
    }

    async agenticWorkflow(prompt, currentFileContent, fileStructure, repoMap, relevantSnippets, conversationHistory = []) {
        console.log('Starting Agentic Workflow (Smart Mode)');

        // Smart model selection: pick the best model for PLANNING (reasoning) and CODING
        const plannerModel = this._getBestAvailableModel('analyze and plan: ' + prompt);
        const coderModel   = this._getBestAvailableModel('implement code: ' + prompt);
        console.log(`[Smart Mode] Planner: ${plannerModel}, Coder: ${coderModel}`);

        const plannerPrompt = `
            You are a Senior Software Architect. Your task is to plan the implementation for the following user request:
            TASK: "${prompt}"

            PROJECT CONTEXT:
            - File Structure: ${fileStructure}
            - Repository Map (Skeletal): ${JSON.stringify(repoMap, null, 2)}
            - Relevant Snippets: ${JSON.stringify(relevantSnippets)}

            GOAL:
            Identify exactly which files need to be created or modified.
            Provide a step-by-step logical sequence for the changes.
            Identify any potential architectural side effects or risks.

            Return ONLY a structured plan.
        `;

        const plan = await this.executeDirect(
            plannerPrompt, currentFileContent, fileStructure, 'chat',
            plannerModel, repoMap, relevantSnippets, conversationHistory,
            true
        );
        console.log('Plan generated.');

        const coderPrompt = `
            You are an expert full-stack developer implementing a plan inside an IDE with an AUTO-WRITE system.

            USER REQUEST: "${prompt}"

            APPROVED ARCHITECTURAL PLAN:
            ${plan}

            ## MANDATORY OUTPUT FORMAT — THE IDE AUTO-WRITE SYSTEM REQUIRES THIS EXACTLY:

            For EVERY file you create or modify, you MUST use this format:
            [FILE: relative/path/to/file.ext]
            \`\`\`language
            complete file content — never truncate
            \`\`\`

            To create an empty folder:
            [FOLDER: relative/path/to/folder]

            For terminal commands use:
            [CMD: command]

            FORBIDDEN: Do NOT use numbered lists, do NOT write "Create this file:", do NOT show code blocks without a [FILE:] tag above them.
            Write COMPLETE file contents. Never abbreviate with "// ... rest of code".
        `;

        const result = await this.executeDirect(
            coderPrompt, currentFileContent, fileStructure, 'chat',
            coderModel, repoMap, relevantSnippets, conversationHistory,
            true
        );

        return `### 📋 ARCHITECTURAL PLAN (by ${plannerModel})\n${plan}\n\n---\n\n### 🚀 IMPLEMENTATION (by ${coderModel})\n${result}`;
    }

    async cooperativeWorkflow(
        prompt, currentFileContent, fileStructure,
        repoMap, relevantSnippets, cooperativeConfig, conversationHistory = []
    ) {
        const best = this._getBestAvailableModel(prompt);
        const plannerModel  = cooperativeConfig.planner  || best;
        const coderModel    = cooperativeConfig.coder    || best;
        const reviewerModel = cooperativeConfig.reviewer || best;

        console.log(
            `Starting Cooperative Flow: Planner (${plannerModel}) → Coder (${coderModel}) → Reviewer (${reviewerModel})`
        );

        const plannerPrompt = `
            You are a Senior Software Architect. Plan the implementation for:
            TASK: "${prompt}"

            PROJECT CONTEXT:
            - File Structure: ${fileStructure}
            - Repository Map: ${JSON.stringify(repoMap, null, 2)}
            - Relevant Snippets: ${JSON.stringify(relevantSnippets)}

            Return ONLY a structured plan.
        `;

        const plan = await this.executeDirect(
            plannerPrompt, currentFileContent, fileStructure, 'chat',
            plannerModel, repoMap, relevantSnippets, conversationHistory,
            true
        );

        const coderPrompt = `
            You are an expert full-stack developer implementing a plan inside an IDE with an AUTO-WRITE system.

            USER REQUEST: "${prompt}"
            APPROVED PLAN: ${plan}

            ## MANDATORY OUTPUT FORMAT — THE IDE AUTO-WRITE SYSTEM REQUIRES THIS EXACTLY:

            For EVERY file you create or modify, you MUST use this format:
            [FILE: relative/path/to/file.ext]
            \`\`\`language
            complete file content — never truncate
            \`\`\`

            For terminal commands use:
            [CMD: command]

            FORBIDDEN: Do NOT use numbered lists. Do NOT write "Create this file:". Do NOT show code blocks without a [FILE:] tag.
            Write COMPLETE file contents. Never abbreviate with "// ... rest of code".
        `;

        const codeResult = await this.executeDirect(
            coderPrompt, currentFileContent, fileStructure, 'chat',
            coderModel, repoMap, relevantSnippets, conversationHistory,
            true
        );

        const reviewerPrompt = `
            You are a Senior QA & Security Engineer reviewing code changes inside an IDE with an AUTO-WRITE system.

            REQUEST: "${prompt}"
            PLAN: ${plan}
            GENERATED CODE: ${codeResult}

            ## MANDATORY OUTPUT FORMAT — OUTPUT EVERY FILE USING THIS EXACT FORMAT:
            [FILE: relative/path/to/file.ext]
            \`\`\`language
            complete polished file content
            \`\`\`

            FORBIDDEN: Do NOT use numbered lists. Every file MUST have a [FILE:] tag. Never truncate content.
        `;

        const reviewedResult = await this.executeDirect(
            reviewerPrompt, currentFileContent, fileStructure, 'chat',
            reviewerModel, repoMap, relevantSnippets, conversationHistory,
            true
        );

        return (
            `### 📋 ARCHITECTURAL PLAN (by ${plannerModel})\n${plan}\n\n---\n\n` +
            `### 🚀 IMPLEMENTATION (by ${coderModel})\n${codeResult}\n\n---\n\n` +
            `### 🔍 CODE REVIEW & POLISH (by ${reviewerModel})\n${reviewedResult}`
        );
    }

    /**
     * Native Anthropic API call (not OpenAI-compatible endpoint).
     */
    async runAnthropic(modelName, systemPrompt, prompt, temperature, maxTokens, conversationHistory = []) {
        const apiKey = this.config.anthropicApiKey;
        if (!apiKey) {
            throw new Error(
                'Anthropic API key not found. Please go to Settings → Connect Anthropic and enter your key.'
            );
        }

        // Build multi-turn messages from conversation history
        const messages = [];
        if (conversationHistory.length > 0) {
            for (const msg of conversationHistory) {
                messages.push({
                    role: msg.role === 'ai' ? 'assistant' : 'user',
                    content: msg.content
                });
            }
        }
        messages.push({ role: 'user', content: prompt });

        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: modelName,
                max_tokens: maxTokens || 8000,
                system: systemPrompt,
                messages,
                temperature: temperature || 0.5,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
            }
        );

        if (response.data?.content?.[0]?.text) {
            return response.data.content[0].text;
        }
        throw new Error('Invalid response structure from Anthropic API');
    }

    /**
     * Resolves the best OpenAI-compatible client for a model name.
     */
    _resolveClient(modelName) {
        const mapping = this.modelMapping[modelName];
        if (mapping?.client) return mapping.client;

        // GPT prefix → OpenAI
        if (modelName.startsWith('gpt-') && this.openai) return this.openai;

        // Local model
        if (modelName.startsWith('local/') || modelName === this.config.localModel) {
            return this.localClient;
        }

        // Search custom providers (exact match, then strip :free)
        if (this.config.customProviders) {
            const baseModelName = modelName.replace(/:free$/, '');

            for (const provider of this.config.customProviders) {
                if (
                    provider.models &&
                    (provider.models.includes(modelName) || provider.models.includes(baseModelName))
                ) {
                    const client = this.customClients[provider.id];
                    if (client) return client;
                }
            }

            // Last resort: first available custom client
            const firstProvider = this.config.customProviders.find(p => this.customClients[p.id]);
            if (firstProvider) {
                console.warn(
                    `No exact mapping for '${modelName}'. Falling back to provider: ${firstProvider.name}`
                );
                return this.customClients[firstProvider.id];
            }
        }

        // OpenRouter catch-all
        if (this.openRouterClient) {
            console.warn(`No exact mapping for '${modelName}'. Falling back to OpenRouter.`);
            return this.openRouterClient;
        }

        return null;
    }

    async executeDirect(
        prompt, currentFileContent, fileStructure,
        mode, modelId, repoMap, relevantSnippets, conversationHistory = [],
        allowFallback = true
    ) {
        const primaryModel = modelId || this.currentModel;

        // Build the try-list: primary first, then fallbacks (skip duplicates)
        const modelsToTry =
            primaryModel === 'smart'
                ? this.fallbackSequence
                : [primaryModel, ...this.fallbackSequence.filter(m => m !== primaryModel)];

        let lastError = null;

        // Initialize active abort controller
        this.activeAbortController = new AbortController();

        try {
            for (const modelName of modelsToTry) {
                try {
                    let systemPrompt = `You are ARIA (Adaptive Runtime Intelligent Assistant), an AI Senior Software Engineer.

PROJECT CONTEXT:
- Structure: ${fileStructure}`;

                    if (repoMap) {
                        systemPrompt += `\n- Repository Map: ${JSON.stringify(repoMap)}`;
                    }

                    if (relevantSnippets?.length > 0) {
                        systemPrompt += `\n- Relevant Snippets: ${relevantSnippets
                            .map(s => `File: ${s.filePath}\n${s.text}`)
                            .join('\n---\n')}`;
                    }

                    systemPrompt += `\nACTIVE FILE:\n---\n${currentFileContent}\n---`;

                    if (mode === 'chat') {
                        systemPrompt += `

## CRITICAL OUTPUT FORMAT RULES — YOU MUST FOLLOW THESE EXACTLY

You are an AI code agent embedded inside an IDE (like Cursor or Trae).
This IDE has an AUTO-WRITE system that reads your output and writes files to disk automatically.
The system ONLY works if you follow the exact format below. Any deviation means files will NOT be created.

### RULE 0 — PLAN AND EXPLAIN FIRST:
Before outputting any [FILE:] or [CMD:] blocks, you MUST write a clear, step-by-step plan and explanation of what you are doing (like the Antigravity assistant). Explain exactly which files you are about to edit or create, the reasoning behind the edits, and what commands you will run to test/build.

### RULE 1 — ALWAYS use [FILE:] blocks for every file you create or modify:

[FILE: relative/path/to/filename.ext]
\`\`\`language
full file content here
\`\`\`

### RULE 1b — To create an empty folder/directory use:

[FOLDER: relative/path/to/folder]

### RULE 2 — ALWAYS use [CMD:] for terminal commands:

[CMD: npm install]

### RULE 3 — STRICT PROHIBITIONS (these will break the auto-write system):
- NEVER use numbered lists like "1. filename.js" followed by a code block
- NEVER describe a file and then show the code without a [FILE:] tag
- NEVER say "Create this file:" and then show a code block — always use [FILE:] instead
- NEVER omit the [FILE: path] tag before any code block that represents a file
- NEVER truncate or abbreviate file content — always write the COMPLETE file content

### RULE 4 — PATH FORMAT:
- Use relative paths from the project root (e.g., [FILE: src/components/App.jsx])
- For new root-level files use (e.g., [FILE: vite.config.js])

### EXAMPLE of CORRECT output:

I'll create the component now.

[FILE: src/components/Button.jsx]
\`\`\`jsx
import React from 'react';
export default function Button({ label }) {
  return <button>{label}</button>;
}
\`\`\`

[FILE: src/styles/button.css]
\`\`\`css
button { padding: 8px 16px; }
\`\`\`

[CMD: npm install framer-motion]

### EXAMPLE of WRONG output (DO NOT DO THIS):
1. src/components/Button.jsx
   \`\`\`jsx
   ... code here ...
   \`\`\`
2. Create vite.config.js in your project root...

IMPORTANT: You have full conversation context. Reference previous messages when relevant.`;
                    } else if (mode === 'complete') {
                        systemPrompt = 'You are a code completion engine. Return ONLY the code that follows. No markdown.';
                    } else if (mode === 'inline-edit') {
                        systemPrompt = 'You are an inline code editor. Return ONLY the revised code replacing the input code. Do NOT wrap in markdown block code fences, and do not provide explanations. Return pure code output only.';
                    }

                    // ── Build multi-turn messages from conversation history ──────
                    const chatMessages = [{ role: 'system', content: systemPrompt }];

                    if (mode === 'chat' && conversationHistory.length > 0) {
                        for (const msg of conversationHistory) {
                            chatMessages.push({
                                role: msg.role === 'ai' ? 'assistant' : 'user',
                                content: msg.content
                            });
                        }
                    }

                    chatMessages.push({ role: 'user', content: prompt });

                    // ── Anthropic (native API) ──────────────────────────────────
                    if (
                        modelName.startsWith('claude-') ||
                        this.modelMapping[modelName]?.provider === 'anthropic'
                    ) {
                        return await this.runAnthropic(
                            modelName, systemPrompt, prompt,
                            (mode === 'complete' || mode === 'inline-edit') ? 0.2 : 0.5,
                            (mode === 'complete' || mode === 'inline-edit') ? 1000 : 8000,
                            conversationHistory
                        );
                    }

                    // ── OpenAI-compatible providers ─────────────────────────────
                    const client = this._resolveClient(modelName);

                    if (!client) {
                        throw new Error(
                            `No provider configured for "${modelName}". ` +
                            `Go to Settings, connect a provider that supports this model, ` +
                            `then pick it from the model dropdown.`
                        );
                    }

                    const response = await client.chat.completions.create({
                        messages: chatMessages,
                        model: modelName,
                        temperature: (mode === 'complete' || mode === 'inline-edit') ? 0.2 : 0.5,
                        max_tokens:  (mode === 'complete' || mode === 'inline-edit') ? 1000  : 8000,
                    }, {
                        signal: this.activeAbortController?.signal
                    });

                    if (response.choices?.[0]?.message?.content) {
                        return response.choices[0].message.content;
                    }

                } catch (error) {
                    console.error(`AI Error (${modelName}):`, error.message);
                    lastError = error;

                    // If user intentionally aborted, throw it immediately to break the loop
                    if (error.name === 'AbortError' || axios.isCancel?.(error) || error.message?.includes('aborted') || error.message?.includes('Cancel')) {
                        throw new Error("Generation cancelled by user.");
                    }

                    // If allowFallback is false and we reached the primary model, throw immediately
                    if (modelName === primaryModel && !allowFallback) {
                        throw error;
                    }

                    continue;
                }
            }
        } finally {
            this.activeAbortController = null;
        }

        throw new Error(lastError?.message || 'All models failed. Please connect at least one provider in Settings.');
    }
}

module.exports = AIService;
