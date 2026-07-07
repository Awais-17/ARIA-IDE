/**
 * agentTools.js
 * ----------------------------------------------------------------------------
 * Tool definitions + executors for ARIA's agentic tool-use loop.
 *
 * Each tool has an OpenAI-style JSON-schema (also convertible to Anthropic's
 * tool format) and a matching executor. Executors run in the Electron MAIN
 * process, so they have direct `fs` / `child_process` access.
 *
 * ctx passed to executeTool:
 *   {
 *     projectRoot : string,                       // absolute path of the open workspace
 *     indexer     : object,                        // IndexerService (for semantic search)
 *     getEmbeddings: (text) => Promise<number[]>,  // embeddings fn for search
 *     onOutput    : (chunk) => void                // optional: stream command output
 *   }
 * ----------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const TurndownService = require('turndown');
const browserManager = require('./browserManager');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.next', 'build', '.cache', 'coverage', 'venv', '.venv', '__pycache__']);
const MAX_READ_LINES = 2000;
const MAX_GREP_MATCHES = 120;
const MAX_GLOB_RESULTS = 400;
const MAX_TOOL_OUTPUT = 30000; // chars — keep tool results from blowing the context window

// ── Path helpers ────────────────────────────────────────────────────────────
function isAbsolutePath(p) {
    return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

function resolvePath(projectRoot, p) {
    if (!p) return projectRoot;
    const cleaned = String(p).replace(/^["']|["']$/g, '').trim();
    if (isAbsolutePath(cleaned)) return path.normalize(cleaned);
    return path.normalize(path.join(projectRoot || '.', cleaned));
}

function relTo(projectRoot, abs) {
    try {
        const r = path.relative(projectRoot || '.', abs).replace(/\\/g, '/');
        return r === '' ? '.' : r;
    } catch {
        return abs;
    }
}

function truncate(str) {
    if (str.length <= MAX_TOOL_OUTPUT) return str;
    return str.slice(0, MAX_TOOL_OUTPUT) + `\n\n… [truncated ${str.length - MAX_TOOL_OUTPUT} more chars]`;
}

// Convert a glob pattern to a RegExp. Supports **, *, ?, and {a,b}.
function globToRegExp(glob) {
    let re = '';
    const g = glob.replace(/\\/g, '/');
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
            else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if (c === '.') re += '\\.';
        else if (c === '/') re += '/';
        else if (c === '{') { re += '(?:'; }
        else if (c === '}') { re += ')'; }
        else if (c === ',') { re += '|'; }
        else if ('+^$()[]|\\'.includes(c)) re += '\\' + c;
        else re += c;
    }
    return new RegExp('^' + re + '$', 'i');
}

// Recursively walk a directory, yielding relative POSIX paths of files.
function walkFiles(root, dir, out, budget) {
    if (out.length >= budget) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
        if (out.length >= budget) return;
        if (ent.isDirectory()) {
            if (IGNORE_DIRS.has(ent.name)) continue;
            walkFiles(root, path.join(dir, ent.name), out, budget);
        } else if (ent.isFile()) {
            out.push(path.join(dir, ent.name));
        }
    }
}

function looksBinary(buf) {
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
    return false;
}

// ── Command execution (used by run_command) ─────────────────────────────────
function runCommandCapture(command, cwd, onOutput) {
    return new Promise((resolve) => {
        let stdout = '', stderr = '';
        let done = false;
        let child;
        try {
            child = spawn(command, [], { cwd: cwd || '.', shell: true, env: { ...process.env, FORCE_COLOR: '1' } });
        } catch (e) {
            return resolve({ success: false, code: -1, stdout: '', stderr: String(e.message) });
        }
        // Hard timeout so a hung command can't freeze the agent loop.
        const timer = setTimeout(() => {
            if (!done) {
                try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
                stderr += '\n[ARIA] Command timed out after 180s and was killed.';
            }
        }, 180000);

        child.stdout.on('data', (d) => { const s = d.toString('utf-8'); stdout += s; onOutput && onOutput({ type: 'stdout', content: s }); });
        child.stderr.on('data', (d) => { const s = d.toString('utf-8'); stderr += s; onOutput && onOutput({ type: 'stderr', content: s }); });
        child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ success: code === 0, code, stdout, stderr }); });
        child.on('error', (err) => { done = true; clearTimeout(timer); resolve({ success: false, code: -1, stdout, stderr, error: err.message }); });
    });
}

// ── Tool schemas (OpenAI function-calling format) ───────────────────────────
const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'view_file',
            description: 'View the contents of a file from the local filesystem. Supports line range.',
            parameters: {
                type: 'object',
                properties: {
                    AbsolutePath: { type: 'string', description: 'Path to file to view, relative to the project root or absolute.' },
                    StartLine: { type: 'integer', description: 'Optional. Startline to view, 1-indexed, inclusive.' },
                    EndLine: { type: 'integer', description: 'Optional. Endline to view, 1-indexed, inclusive.' }
                },
                required: ['AbsolutePath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file in the workspace (legacy). Optionally read only a line range. Use this to understand code before editing it.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path, relative to the project root.' },
                    start_line: { type: 'integer', description: 'Optional 1-based start line.' },
                    end_line: { type: 'integer', description: 'Optional 1-based end line (inclusive).' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_dir',
            description: 'List files and folders in a directory (non-recursive). Use to explore the project layout.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Directory path relative to project root. Defaults to root.' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files whose path matches a glob pattern (supports ** , * , ? , {a,b}). e.g. "src/**/*.jsx".',
            parameters: {
                type: 'object',
                properties: { pattern: { type: 'string', description: 'Glob pattern relative to the project root.' } },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Use ripgrep-like search to find exact pattern matches within files or directories.',
            parameters: {
                type: 'object',
                properties: {
                    SearchPath: { type: 'string', description: 'The path to search. Must be an absolute path or relative to project root.' },
                    Query: { type: 'string', description: 'The search term or pattern to look for within files.' },
                    IsRegex: { type: 'boolean', description: 'If true, treats Query as a regular expression pattern.' },
                    CaseInsensitive: { type: 'boolean', description: 'If true, performs a case-insensitive search.' },
                    MatchPerLine: { type: 'boolean', description: 'If true, returns each line that matches including line numbers.' },
                    Includes: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to filter files.' }
                },
                required: ['SearchPath', 'Query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search file contents for a regular expression across the workspace (legacy). Returns matching file:line: text.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regular expression to search for.' },
                    path: { type: 'string', description: 'Optional subdirectory to limit the search.' },
                    include: { type: 'string', description: 'Optional glob to filter files, e.g. "*.js".' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_codebase',
            description: 'Semantic (vector) search over the indexed codebase. Use for "where is X handled" conceptual questions when you do not know exact keywords.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Natural-language search query.' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_to_file',
            description: 'Create a new file or completely overwrite an existing one with the given content.',
            parameters: {
                type: 'object',
                properties: {
                    TargetFile: { type: 'string', description: 'The target file to create and write code to.' },
                    CodeContent: { type: 'string', description: 'The code contents to write to the file.' },
                    Overwrite: { type: 'boolean', description: 'Set this to true to overwrite an existing file.' },
                    Description: { type: 'string', description: 'Brief explanation of what this change did.' }
                },
                required: ['TargetFile', 'Overwrite', 'CodeContent']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Create a new file or completely overwrite an existing one with the given content (legacy). Prefer edit_file for changes to existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the project root.' },
                    content: { type: 'string', description: 'The complete file content.' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'replace_file_content',
            description: 'Replace a single contiguous block of text in a file. StartLine and EndLine should specify a range containing precisely the TargetContent to edit.',
            parameters: {
                type: 'object',
                properties: {
                    TargetFile: { type: 'string', description: 'The target file to modify.' },
                    StartLine: { type: 'integer', description: 'The starting line number of the chunk (1-indexed).' },
                    EndLine: { type: 'integer', description: 'The ending line number of the chunk (1-indexed).' },
                    TargetContent: { type: 'string', description: 'The exact string to be replaced. Must match the file content exactly.' },
                    ReplacementContent: { type: 'string', description: 'The content to replace the target content with.' },
                    AllowMultiple: { type: 'boolean', description: 'If true, multiple occurrences will be replaced. Otherwise, errors if multiple are found.' },
                    Description: { type: 'string', description: 'Brief explanation of what this change did.' }
                },
                required: ['TargetFile', 'StartLine', 'EndLine', 'TargetContent', 'ReplacementContent']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'multi_replace_file_content',
            description: 'Edit multiple, non-adjacent lines of code in the same file. Specify each edit as a separate ReplacementChunk.',
            parameters: {
                type: 'object',
                properties: {
                    TargetFile: { type: 'string', description: 'The target file to modify.' },
                    Instruction: { type: 'string', description: 'A description of the changes you are making.' },
                    Description: { type: 'string', description: 'Brief explanation of what this change did.' },
                    ReplacementChunks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                StartLine: { type: 'integer', description: 'The starting line number of the chunk (1-indexed).' },
                                EndLine: { type: 'integer', description: 'The ending line number of the chunk (1-indexed).' },
                                TargetContent: { type: 'string', description: 'The exact string to be replaced.' },
                                ReplacementContent: { type: 'string', description: 'The content to replace the target content with.' },
                                AllowMultiple: { type: 'boolean', description: 'If true, multiple occurrences will be replaced.' }
                            },
                            required: ['StartLine', 'EndLine', 'TargetContent', 'ReplacementContent']
                        }
                    }
                },
                required: ['TargetFile', 'Instruction', 'ReplacementChunks']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make a targeted edit by replacing an exact string with a new one (legacy). Prefer this over write_file for existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the project root.' },
                    old_string: { type: 'string', description: 'The exact text to replace.' },
                    new_string: { type: 'string', description: 'The replacement text.' },
                    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' }
                },
                required: ['path', 'old_string', 'new_string']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command in the workspace (e.g. npm install, npm run build, npm test, python script). Returns stdout, stderr and exit code. Use this to install deps and to VERIFY your changes by building/testing.',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string', description: 'The shell command to run.' } },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_todos',
            description: 'Maintain a visible task checklist for the user. Call at the start of a multi-step task with the full plan, then again to mark items in_progress/completed as you go.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full, ordered task list (send the complete list every time).',
                        items: {
                            type: 'object',
                            properties: {
                                content: { type: 'string', description: 'Short task description.' },
                                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status.' }
                            },
                            required: ['content', 'status']
                        }
                    }
                },
                required: ['todos']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Performs a web search for a given query.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'The search query.' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the live web (via Tavily) for current information (legacy). Requires a Tavily API key connected in Settings.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'The search query.' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_url_content',
            description: 'Fetch content from a URL via HTTP request and convert HTML to markdown.',
            parameters: {
                type: 'object',
                properties: { Url: { type: 'string', description: 'The full URL to read.' } },
                required: ['Url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a URL and return its content converted to readable markdown (legacy). Use this to read documentation pages, GitHub files, API references, etc.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', description: 'The full URL to fetch.' } },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_action',
            description: 'Control a real Chrome browser window: navigate, read page text, click, type into fields, list interactive elements, screenshot, or close. Use for tasks that require an actual rendered/interactive web page rather than just fetching raw HTML (logging in, JS-heavy sites, visual checks).',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['navigate', 'read', 'click', 'type', 'list_elements', 'screenshot', 'close'], description: 'The browser action to perform.' },
                    url: { type: 'string', description: 'Required for "navigate".' },
                    selector: { type: 'string', description: 'CSS selector, required for "click" and "type".' },
                    text: { type: 'string', description: 'Text to type, used with "type".' }
                },
                required: ['type']
            }
        }
    }
];

// Names of tools that mutate the workspace or run code (used for UI labelling).
const MUTATING_TOOLS = new Set([
    'write_file',
    'edit_file',
    'run_command',
    'browser_action',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content'
]);

// ── Anthropic tool-format conversion ────────────────────────────────────────
function toAnthropicTools() {
    return TOOL_SCHEMAS.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
    }));
}

// ── Executor ────────────────────────────────────────────────────────────────
/**
 * Runs a single tool. Returns { ok, content, meta } where `content` is a string
 * fed back to the model and `meta` carries structured data for the UI
 * (e.g. file diffs, todos).
 */
async function executeTool(name, args, ctx) {
    const projectRoot = ctx.projectRoot || '.';
    try {
        switch (name) {
            case 'view_file': {
                const abs = resolvePath(projectRoot, args.AbsolutePath);
                if (!fs.existsSync(abs)) return { ok: false, content: `File not found: ${args.AbsolutePath}` };
                const buf = fs.readFileSync(abs);
                if (looksBinary(buf)) return { ok: false, content: `Cannot read binary file: ${args.AbsolutePath}` };
                let text = buf.toString('utf-8');
                const lines = text.split(/\r?\n/);
                let start = args.StartLine ? Math.max(1, args.StartLine) : 1;
                let end = args.EndLine ? Math.min(lines.length, args.EndLine) : lines.length;
                let note = '';
                if (!args.StartLine && !args.EndLine && lines.length > MAX_READ_LINES) {
                    end = MAX_READ_LINES;
                    note = `\n\n[Showing lines 1-${MAX_READ_LINES} of ${lines.length}. Use StartLine/EndLine to view more.]`;
                }
                const slice = lines.slice(start - 1, end).join('\n');
                return { ok: true, content: truncate(slice) + note };
            }

            case 'read_file': {
                const abs = resolvePath(projectRoot, args.path);
                if (!fs.existsSync(abs)) return { ok: false, content: `File not found: ${args.path}` };
                const buf = fs.readFileSync(abs);
                if (looksBinary(buf)) return { ok: false, content: `Cannot read binary file: ${args.path}` };
                let text = buf.toString('utf-8');
                const lines = text.split(/\r?\n/);
                let start = args.start_line ? Math.max(1, args.start_line) : 1;
                let end = args.end_line ? Math.min(lines.length, args.end_line) : lines.length;
                let note = '';
                if (!args.start_line && !args.end_line && lines.length > MAX_READ_LINES) {
                    end = MAX_READ_LINES;
                    note = `\n\n[Showing lines 1-${MAX_READ_LINES} of ${lines.length}. Use start_line/end_line to read more.]`;
                }
                const slice = lines.slice(start - 1, end).join('\n');
                return { ok: true, content: truncate(slice) + note };
            }

            case 'list_dir': {
                const abs = resolvePath(projectRoot, args.path || '.');
                if (!fs.existsSync(abs)) return { ok: false, content: `Directory not found: ${args.path || '.'}` };
                const entries = fs.readdirSync(abs, { withFileTypes: true });
                const out = entries
                    .filter(e => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
                    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
                    .sort();
                return { ok: true, content: out.length ? out.join('\n') : '(empty directory)' };
            }

            case 'glob': {
                const files = [];
                walkFiles(projectRoot, projectRoot, files, 20000);
                const re = globToRegExp(args.pattern);
                const matches = files
                    .map(f => relTo(projectRoot, f))
                    .filter(rel => re.test(rel))
                    .slice(0, MAX_GLOB_RESULTS);
                return { ok: true, content: matches.length ? matches.join('\n') : `No files match: ${args.pattern}` };
            }

            case 'grep_search': {
                let re;
                const query = args.Query;
                const isRegex = !!args.IsRegex;
                const caseInsensitive = !!args.CaseInsensitive;
                const matchPerLine = !!args.MatchPerLine;
                try {
                    re = new RegExp(isRegex ? query : query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), caseInsensitive ? 'gi' : 'g');
                } catch (e) {
                    return { ok: false, content: `Invalid regex query: ${query}` };
                }
                const baseDir = resolvePath(projectRoot, args.SearchPath || '.');
                if (!fs.existsSync(baseDir)) return { ok: false, content: `Search path not found: ${args.SearchPath}` };
                const files = [];
                if (fs.statSync(baseDir).isFile()) {
                    files.push(baseDir);
                } else {
                    walkFiles(projectRoot, baseDir, files, 20000);
                }
                const includeRes = (args.Includes || []).map(inc => globToRegExp(inc.includes('/') ? inc : '**/' + inc));
                const results = [];
                for (const f of files) {
                    if (results.length >= MAX_GREP_MATCHES) break;
                    const rel = relTo(projectRoot, f);
                    if (includeRes.length > 0 && !includeRes.some(re => re.test(rel))) continue;
                    let buf;
                    try { buf = fs.readFileSync(f); } catch { continue; }
                    if (looksBinary(buf)) continue;
                    const contentStr = buf.toString('utf-8');
                    if (matchPerLine) {
                        const lines = contentStr.split(/\r?\n/);
                        for (let i = 0; i < lines.length; i++) {
                            re.lastIndex = 0;
                            if (re.test(lines[i])) {
                                results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
                                if (results.length >= MAX_GREP_MATCHES) break;
                            }
                        }
                    } else {
                        re.lastIndex = 0;
                        if (re.test(contentStr)) {
                            results.push(rel);
                        }
                    }
                }
                return { ok: true, content: results.length ? truncate(results.join('\n')) : `No matches for: ${query}` };
            }

            case 'grep': {
                let re;
                try { re = new RegExp(args.pattern, 'g'); }
                catch { return { ok: false, content: `Invalid regex: ${args.pattern}` }; }
                const baseDir = resolvePath(projectRoot, args.path || '.');
                const files = [];
                walkFiles(projectRoot, baseDir, files, 20000);
                const includeRe = args.include ? globToRegExp(args.include.includes('/') ? args.include : '**/' + args.include) : null;
                const results = [];
                for (const f of files) {
                    if (results.length >= MAX_GREP_MATCHES) break;
                    const rel = relTo(projectRoot, f);
                    if (includeRe && !includeRe.test(rel)) continue;
                    let buf;
                    try { buf = fs.readFileSync(f); } catch { continue; }
                    if (looksBinary(buf)) continue;
                    const lines = buf.toString('utf-8').split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        re.lastIndex = 0;
                        if (re.test(lines[i])) {
                            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
                            if (results.length >= MAX_GREP_MATCHES) break;
                        }
                    }
                }
                return { ok: true, content: results.length ? truncate(results.join('\n')) : `No matches for: ${args.pattern}` };
            }

            case 'search_codebase': {
                if (!ctx.indexer || !ctx.getEmbeddings) return { ok: false, content: 'Semantic search unavailable (no index).' };
                let results = [];
                try { results = await ctx.indexer.search(args.query, ctx.getEmbeddings, 5); } catch (e) { return { ok: false, content: `Search error: ${e.message}` }; }
                if (!results || !results.length) return { ok: true, content: '(no semantic matches found)' };
                const formatted = results.map(r => `File: ${r.filePath}\n${(r.text || '').slice(0, 1200)}`).join('\n---\n');
                return { ok: true, content: truncate(formatted) };
            }

            case 'write_to_file': {
                const abs = resolvePath(projectRoot, args.TargetFile);
                const existedBefore = fs.existsSync(abs);
                if (existedBefore && !args.Overwrite) {
                    return { ok: false, content: `File already exists at ${args.TargetFile} and Overwrite is false. Set Overwrite to true to replace.` };
                }
                const before = existedBefore ? fs.readFileSync(abs, 'utf-8') : '';
                const dir = path.dirname(abs);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(abs, args.CodeContent ?? '', 'utf-8');
                return {
                    ok: true,
                    content: `${existedBefore ? 'Overwrote' : 'Created'} ${args.TargetFile} (${(args.CodeContent || '').split(/\r?\n/).length} lines).`,
                    meta: { fileChange: { path: relTo(projectRoot, abs), action: existedBefore ? 'modified' : 'created', before, after: args.CodeContent ?? '' } }
                };
            }

            case 'write_file': {
                const abs = resolvePath(projectRoot, args.path);
                const existedBefore = fs.existsSync(abs);
                const before = existedBefore ? fs.readFileSync(abs, 'utf-8') : '';
                const dir = path.dirname(abs);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(abs, args.content ?? '', 'utf-8');
                return {
                    ok: true,
                    content: `${existedBefore ? 'Overwrote' : 'Created'} ${args.path} (${(args.content || '').split(/\r?\n/).length} lines).`,
                    meta: { fileChange: { path: relTo(projectRoot, abs), action: existedBefore ? 'modified' : 'created', before, after: args.content ?? '' } }
                };
            }

            case 'replace_file_content': {
                const abs = resolvePath(projectRoot, args.TargetFile);
                if (!fs.existsSync(abs)) return { ok: false, content: `Cannot edit — file not found: ${args.TargetFile}. Use write_to_file to create it.` };
                const before = fs.readFileSync(abs, 'utf-8');
                const targetContent = args.TargetContent ?? '';
                const replacementContent = args.ReplacementContent ?? '';
                if (targetContent === '') return { ok: false, content: 'replace_file_content requires a non-empty TargetContent.' };
                const occurrences = before.split(targetContent).length - 1;
                if (occurrences === 0) return { ok: false, content: `TargetContent not found in ${args.TargetFile}. Read the file again and copy the exact text (including whitespace).` };
                if (occurrences > 1 && !args.AllowMultiple) return { ok: false, content: `TargetContent appears ${occurrences} times in ${args.TargetFile}. Add more surrounding context to make it unique, or set AllowMultiple=true.` };
                const after = args.AllowMultiple ? before.split(targetContent).join(replacementContent) : before.replace(targetContent, replacementContent);
                fs.writeFileSync(abs, after, 'utf-8');
                return {
                    ok: true,
                    content: `Edited ${args.TargetFile} (${occurrences} replacement${occurrences > 1 ? 's' : ''}).`,
                    meta: { fileChange: { path: relTo(projectRoot, abs), action: 'modified', before, after } }
                };
            }

            case 'multi_replace_file_content': {
                const abs = resolvePath(projectRoot, args.TargetFile);
                if (!fs.existsSync(abs)) return { ok: false, content: `Cannot edit — file not found: ${args.TargetFile}` };
                let currentContent = fs.readFileSync(abs, 'utf-8');
                const before = currentContent;
                const chunks = args.ReplacementChunks || [];
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const targetContent = chunk.TargetContent;
                    const replacementContent = chunk.ReplacementContent;
                    const occurrences = currentContent.split(targetContent).length - 1;
                    if (occurrences === 0) {
                        return { ok: false, content: `Chunk ${i + 1} TargetContent not found in ${args.TargetFile}. Aborting all replacements.` };
                    }
                    if (occurrences > 1 && !chunk.AllowMultiple) {
                        return { ok: false, content: `Chunk ${i + 1} TargetContent matches ${occurrences} times in ${args.TargetFile}. Make it more specific or allow multiple.` };
                    }
                    currentContent = chunk.AllowMultiple ? currentContent.split(targetContent).join(replacementContent) : currentContent.replace(targetContent, replacementContent);
                }
                fs.writeFileSync(abs, currentContent, 'utf-8');
                return {
                    ok: true,
                    content: `Successfully applied ${chunks.length} replacement chunks to ${args.TargetFile}.`,
                    meta: { fileChange: { path: relTo(projectRoot, abs), action: 'modified', before, after: currentContent } }
                };
            }

            case 'edit_file': {
                const abs = resolvePath(projectRoot, args.path);
                if (!fs.existsSync(abs)) return { ok: false, content: `Cannot edit — file not found: ${args.path}. Use write_file to create it.` };
                const before = fs.readFileSync(abs, 'utf-8');
                const oldStr = args.old_string ?? '';
                const newStr = args.new_string ?? '';
                if (oldStr === '') return { ok: false, content: 'edit_file requires a non-empty old_string.' };
                const occurrences = before.split(oldStr).length - 1;
                if (occurrences === 0) return { ok: false, content: `old_string not found in ${args.path}. Read the file again and copy the exact text (including whitespace).` };
                if (occurrences > 1 && !args.replace_all) return { ok: false, content: `old_string appears ${occurrences} times in ${args.path}. Add more surrounding context to make it unique, or set replace_all=true.` };
                const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
                fs.writeFileSync(abs, after, 'utf-8');
                return {
                    ok: true,
                    content: `Edited ${args.path} (${occurrences} replacement${occurrences > 1 ? 's' : ''}).`,
                    meta: { fileChange: { path: relTo(projectRoot, abs), action: 'modified', before, after } }
                };
            }

            case 'run_command': {
                const res = await runCommandCapture(args.command, projectRoot, ctx.onOutput);
                const out =
                    `Exit code: ${res.code}\n` +
                    `STDOUT:\n${(res.stdout || '(empty)').slice(0, 12000)}\n` +
                    `STDERR:\n${(res.stderr || '(empty)').slice(0, 8000)}` +
                    (res.error ? `\nERROR: ${res.error}` : '');
                return { ok: res.success, content: truncate(out), meta: { command: { command: args.command, ...res } } };
            }

            case 'update_todos': {
                const todos = Array.isArray(args.todos) ? args.todos : [];
                return { ok: true, content: `Task list updated (${todos.filter(t => t.status === 'completed').length}/${todos.length} done).`, meta: { todos } };
            }

            case 'search_web': {
                if (!ctx.tavilyApiKey) return { ok: false, content: 'Web search unavailable — connect a Tavily API key in Settings.' };
                try {
                    const res = await axios.post('https://api.tavily.com/search', {
                        api_key: ctx.tavilyApiKey,
                        query: args.query,
                        max_results: 5,
                    }, { timeout: 20000 });
                    const results = res.data?.results || [];
                    if (!results.length) return { ok: true, content: '(no search results found)' };
                    const formatted = results.map(r => `${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`).join('\n---\n');
                    return { ok: true, content: truncate(formatted) };
                } catch (e) {
                    return { ok: false, content: `Web search failed: ${e.response?.data?.detail || e.message}` };
                }
            }

            case 'web_search': {
                if (!ctx.tavilyApiKey) return { ok: false, content: 'Web search unavailable — connect a Tavily API key in Settings.' };
                try {
                    const res = await axios.post('https://api.tavily.com/search', {
                        api_key: ctx.tavilyApiKey,
                        query: args.query,
                        max_results: 5,
                    }, { timeout: 20000 });
                    const results = res.data?.results || [];
                    if (!results.length) return { ok: true, content: '(no search results found)' };
                    const formatted = results.map(r => `${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`).join('\n---\n');
                    return { ok: true, content: truncate(formatted) };
                } catch (e) {
                    return { ok: false, content: `Web search failed: ${e.response?.data?.detail || e.message}` };
                }
            }

            case 'read_url_content': {
                try {
                    const res = await axios.get(args.Url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARIA-Agent/1.0)' } });
                    const contentType = String(res.headers?.['content-type'] || '');
                    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    if (!contentType.includes('html')) return { ok: true, content: truncate(body) };
                    const turndownService = new TurndownService();
                    turndownService.remove(['script', 'style', 'noscript']);
                    const markdown = turndownService.turndown(body);
                    return { ok: true, content: truncate(markdown) };
                } catch (e) {
                    return { ok: false, content: `Failed to fetch ${args.Url}: ${e.message}` };
                }
            }

            case 'web_fetch': {
                try {
                    const res = await axios.get(args.url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARIA-Agent/1.0)' } });
                    const contentType = String(res.headers?.['content-type'] || '');
                    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    if (!contentType.includes('html')) return { ok: true, content: truncate(body) };
                    const turndownService = new TurndownService();
                    turndownService.remove(['script', 'style', 'noscript']);
                    const markdown = turndownService.turndown(body);
                    return { ok: true, content: truncate(markdown) };
                } catch (e) {
                    return { ok: false, content: `Failed to fetch ${args.url}: ${e.message}` };
                }
            }

            case 'browser_action':
                return await browserManager.runBrowserAction(args);

            default:
                return { ok: false, content: `Unknown tool: ${name}` };
        }
    } catch (e) {
        return { ok: false, content: `Tool '${name}' failed: ${e.message}` };
    }
}

module.exports = {
    TOOL_SCHEMAS,
    MUTATING_TOOLS,
    toAnthropicTools,
    executeTool,
    resolvePath,
    runCommandCapture
};
