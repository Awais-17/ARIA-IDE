const path = require('path');
const fs = require('fs');

/**
 * IndexerService - Pure JavaScript implementation
 * No native modules (tree-sitter, hnswlib) to avoid crashes on Windows.
 * Uses regex-based parsing for skeletal repo maps and cosine-distance vector search.
 */
class IndexerService {
    constructor() {
        this.chunkMetadata = [];
        this.embeddingDim = 1536;
    }

    getLanguageForFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const map = {
            '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
            '.ts': 'typescript', '.tsx': 'typescript',
            '.py': 'python', '.go': 'go', '.rs': 'rust',
            '.java': 'java', '.cpp': 'cpp', '.cc': 'cpp', '.c': 'c',
            '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
            '.html': 'html', '.css': 'css', '.json': 'json',
            '.md': 'markdown'
        };
        return map[ext] || null;
    }

    /**
     * Extract a skeletal view using regex patterns (no tree-sitter needed).
     * Captures exports, classes, functions, interfaces, types.
     */
    extractSkeletalView(content, langName) {
        const lines = content.split('\n');
        const skeleton = [];

        const patterns = [
            /^\s*export\s+(default\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/,
            /^\s*(export\s+)?class\s+(\w+)/,
            /^\s*(export\s+)?(async\s+)?function\s+(\w+)/,
            /^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(.*\)\s*=>/,
            /^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?function/,
            /^\s*(export\s+)?interface\s+(\w+)/,
            /^\s*(export\s+)?type\s+(\w+)/,
            /^\s*(export\s+)?enum\s+(\w+)/,
            /^\s*(public|private|protected|static)?\s*(async\s+)?(\w+)\s*\(.*\)\s*[:{]/,
            /^\s*def\s+(\w+)\s*\(/,        // Python
            /^\s*func\s+(\w+)\s*\(/,        // Go
            /^\s*fn\s+(\w+)\s*\(/,          // Rust
        ];

        for (const line of lines) {
            for (const pattern of patterns) {
                if (pattern.test(line)) {
                    skeleton.push(line.trimEnd());
                    break;
                }
            }
        }

        return skeleton.join('\n');
    }

    async generateRepoMap(rootPath) {
        const map = {};
        const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'dist-electron', '.next', '__pycache__']);
        const MAX_FILE_SIZE = 500000; // 500KB

        const walk = (dir) => {
            let files;
            try {
                files = fs.readdirSync(dir);
            } catch (e) {
                return;
            }

            for (const file of files) {
                if (IGNORED.has(file)) continue;

                const fullPath = path.join(dir, file);
                let stats;
                try {
                    stats = fs.statSync(fullPath);
                } catch (e) {
                    continue;
                }

                if (stats.isDirectory()) {
                    walk(fullPath);
                } else if (stats.size < MAX_FILE_SIZE) {
                    const langName = this.getLanguageForFile(fullPath);
                    if (langName) {
                        try {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            const relativePath = path.relative(rootPath, fullPath);
                            const skeletal = this.extractSkeletalView(content, langName);
                            if (skeletal) {
                                map[relativePath] = skeletal;
                            }
                        } catch (e) {
                            // Skip unreadable files
                        }
                    }
                }
            }
        };

        try {
            walk(rootPath);
        } catch (e) {
            console.error("Error generating repo map:", e);
        }
        return map;
    }

    async indexProjectVectors(rootPath, getEmbeddings) {
        this.chunkMetadata = [];
        const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'dist-electron', '.next', '__pycache__']);
        const INDEXABLE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.md', '.txt', '.html', '.css', '.json']);
        const MAX_FILE_SIZE = 200000; // 200KB

        const walk = async (dir) => {
            let files;
            try {
                files = fs.readdirSync(dir);
            } catch (e) {
                return;
            }

            for (const file of files) {
                if (IGNORED.has(file)) continue;

                const fullPath = path.join(dir, file);
                let stats;
                try {
                    stats = fs.statSync(fullPath);
                } catch (e) {
                    continue;
                }

                if (stats.isDirectory()) {
                    await walk(fullPath);
                } else {
                    const ext = path.extname(fullPath).toLowerCase();
                    if (INDEXABLE_EXTS.has(ext) && stats.size < MAX_FILE_SIZE) {
                        try {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            if (!content.trim()) continue;

                            const chunks = this.chunkText(content, 1000);
                            for (let i = 0; i < chunks.length; i++) {
                                const chunkText = `File: ${path.relative(rootPath, fullPath)}\n\n${chunks[i]}`;
                                const embedding = await getEmbeddings(chunkText);
                                this.chunkMetadata.push({
                                    id: this.chunkMetadata.length,
                                    filePath: path.relative(rootPath, fullPath),
                                    text: chunks[i],
                                    embedding: embedding
                                });
                            }
                        } catch (err) {
                            console.error(`Error processing ${fullPath}:`, err);
                        }
                    }
                }
            }
        };

        try {
            await walk(rootPath);
            console.log(`Vector indexing complete: ${this.chunkMetadata.length} chunks indexed.`);
        } catch (e) {
            console.error("Vector indexing error:", e);
        }
    }

    chunkText(text, chunkSize) {
        const chunks = [];
        for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.slice(i, Math.min(i + chunkSize, text.length)));
        }
        return chunks;
    }

    async search(query, getEmbeddings, k = 5) {
        if (this.chunkMetadata.length === 0) return [];
        try {
            const queryEmbedding = await getEmbeddings(query);
            if (!queryEmbedding || queryEmbedding.length === 0) return [];

            const results = this.chunkMetadata.map(chunk => {
                let dist = 0;
                const e = chunk.embedding;
                if (e && e.length === queryEmbedding.length) {
                    for (let i = 0; i < e.length; i++) {
                        const diff = queryEmbedding[i] - e[i];
                        dist += diff * diff;
                    }
                } else {
                    dist = Infinity;
                }
                return { ...chunk, score: dist };
            });

            results.sort((a, b) => a.score - b.score);
            return results.slice(0, k);
        } catch (error) {
            console.error("Vector search error:", error);
            return [];
        }
    }
}

module.exports = IndexerService;
