/**
 * mcpManager.js
 * ----------------------------------------------------------------------------
 * MCP (Model Context Protocol) client manager for ARIA's agentic tool-use loop.
 *
 * Connects to configured MCP servers (local stdio processes or remote
 * Streamable-HTTP servers), discovers their tools, and exposes them in the
 * same { ok, content, meta } shape used by services/agentTools.js so the
 * agent loop's dispatcher can treat MCP tools identically to local ones.
 *
 * Tool names are namespaced as `mcp__<serverId>__<originalToolName>` to avoid
 * collisions between servers (and with the built-in tools).
 * ----------------------------------------------------------------------------
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const TOOL_PREFIX = 'mcp__';
const MAX_TOOL_OUTPUT = 30000;

function truncate(str) {
    if (str.length <= MAX_TOOL_OUTPUT) return str;
    return str.slice(0, MAX_TOOL_OUTPUT) + `\n\n… [truncated ${str.length - MAX_TOOL_OUTPUT} more chars]`;
}

async function createClient(cfg) {
    const client = new Client({ name: 'helios-aria', version: '1.0.0' }, { capabilities: {} });
    let transport;
    if (cfg.transport === 'http') {
        if (!cfg.url) throw new Error('Missing server URL.');
        const headers = cfg.headers && Object.keys(cfg.headers).length ? cfg.headers : undefined;
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), headers ? { requestInit: { headers } } : undefined);
    } else {
        if (!cfg.command) throw new Error('Missing server command.');
        transport = new StdioClientTransport({
            command: cfg.command,
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env || {},
        });
    }
    await client.connect(transport);
    return { client, transport };
}

function toolResultToContent(result) {
    const text = (result.content || [])
        .map(b => (b.type === 'text' ? b.text : `[${b.type} content omitted]`))
        .join('\n')
        .trim();
    return text || '(empty result)';
}

class McpManager {
    constructor() {
        // id -> { config, client, transport, tools: Map(qualifiedName -> {originalName, schema}), status, error }
        this.servers = new Map();
    }

    /** Reconciles connected servers against a new server-config list (e.g. after Settings save). */
    async reload(serverConfigs = []) {
        const configs = Array.isArray(serverConfigs) ? serverConfigs : [];
        const wanted = new Map(configs.filter(c => c.enabled !== false && c.id).map(c => [c.id, c]));

        for (const [id, entry] of [...this.servers]) {
            const cfg = wanted.get(id);
            if (!cfg || JSON.stringify(cfg) !== JSON.stringify(entry.config)) {
                await this._disconnectEntry(entry);
                this.servers.delete(id);
            }
        }

        for (const cfg of wanted.values()) {
            if (this.servers.has(cfg.id)) continue; // unchanged, still connected
            await this._connect(cfg);
        }
    }

    async _connect(cfg) {
        const entry = { config: cfg, client: null, transport: null, tools: new Map(), status: 'connecting', error: null };
        this.servers.set(cfg.id, entry);
        try {
            const { client, transport } = await createClient(cfg);
            entry.client = client;
            entry.transport = transport;
            const { tools } = await client.listTools();
            for (const tool of tools) {
                entry.tools.set(`${TOOL_PREFIX}${cfg.id}__${tool.name}`, { originalName: tool.name, schema: tool });
            }
            entry.status = 'connected';
        } catch (e) {
            entry.status = 'error';
            entry.error = e.message;
        }
    }

    async _disconnectEntry(entry) {
        try { await entry.client?.close(); } catch { /* best-effort */ }
        try { await entry.transport?.close(); } catch { /* best-effort */ }
    }

    async disconnectAll() {
        for (const entry of this.servers.values()) await this._disconnectEntry(entry);
        this.servers.clear();
    }

    /** Briefly connects to a candidate server config to validate it and list its tools, then disconnects. Used by the "Test Connection" UI action — does not affect the persisted/active connection set. */
    async testConnect(cfg) {
        let client, transport;
        try {
            ({ client, transport } = await createClient(cfg));
            const { tools } = await client.listTools();
            return { ok: true, tools: tools.map(t => ({ name: t.name, description: t.description || '' })) };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            if (client || transport) await this._disconnectEntry({ client, transport });
        }
    }

    hasTool(name) {
        for (const entry of this.servers.values()) if (entry.tools.has(name)) return true;
        return false;
    }

    /** MCP tools are treated as mutating (approval-gated) unless the server explicitly annotates readOnlyHint: true. */
    isMutating(name) {
        for (const entry of this.servers.values()) {
            const t = entry.tools.get(name);
            if (t) return t.schema.annotations?.readOnlyHint !== true;
        }
        return true;
    }

    getOpenAISchemas() {
        const schemas = [];
        for (const entry of this.servers.values()) {
            if (entry.status !== 'connected') continue;
            for (const [qualifiedName, t] of entry.tools) {
                schemas.push({
                    type: 'function',
                    function: {
                        name: qualifiedName,
                        description: `[MCP: ${entry.config.name}] ${t.schema.description || ''}`.slice(0, 1024),
                        parameters: t.schema.inputSchema || { type: 'object', properties: {} },
                    },
                });
            }
        }
        return schemas;
    }

    getAnthropicTools() {
        return this.getOpenAISchemas().map(s => ({
            name: s.function.name,
            description: s.function.description,
            input_schema: s.function.parameters,
        }));
    }

    async callTool(qualifiedName, args) {
        for (const entry of this.servers.values()) {
            const t = entry.tools.get(qualifiedName);
            if (!t) continue;
            try {
                const result = await entry.client.callTool({ name: t.originalName, arguments: args || {} });
                return { ok: !result.isError, content: truncate(toolResultToContent(result)) };
            } catch (e) {
                return { ok: false, content: `MCP tool '${qualifiedName}' failed: ${e.message}` };
            }
        }
        return { ok: false, content: `Unknown MCP tool: ${qualifiedName}` };
    }

    /** Connection status for every configured server, for the Settings UI. */
    listStatus() {
        return [...this.servers.entries()].map(([id, entry]) => ({
            id,
            name: entry.config.name,
            status: entry.status,
            error: entry.error,
            toolCount: entry.tools.size,
            tools: [...entry.tools.values()].map(t => t.originalName),
        }));
    }
}

module.exports = McpManager;
