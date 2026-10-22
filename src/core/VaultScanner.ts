import { App, TFile, normalizePath } from "obsidian";
import { getHighlightsFromContent } from "../utils/export";
import type { Highlight } from "../utils/highlights";

export interface ScanResult {
    file: TFile;
    highlights: Highlight[];
    frontmatter: Record<string, unknown>;
}

interface CacheEntry {
    mtime: number;
    highlights: Highlight[];
    frontmatter: Record<string, unknown>;
}

type ProgressCallback = (current: number, total: number, filename: string) => void;

function parseFolders(value = ""): string[] {
    if (typeof value !== "string") throw new Error("Use vault-relative folder paths, one per line.");
    return value
        .split(/\r?\n/)
        .map((folder) => folder.trim())
        .filter(Boolean)
        .map((folder) => {
            if (
                /^(?:[/\\]|[a-z]:)/i.test(folder) ||
                folder.split(/[/\\]+/).some((part) => part === "." || part === "..")
            ) {
                throw new Error("Use vault-relative folder paths without '.' or '..', one per line.");
            }
            return normalizePath(folder);
        });
}

export class VaultScanner {
    app: App;
    cache: Map<string, CacheEntry>;

    constructor(app: App) {
        this.app = app;
        this.cache = new Map();
    }

    /**
     * Lists Markdown paths, then reads only notes in the requested folders.
     */
    async scanVault(
        onProgress: ProgressCallback = () => {},
        scope: { includeFolders?: string; excludeFolders?: string; signal?: AbortSignal } = {}
    ): Promise<ScanResult[]> {
        scope.signal?.throwIfAborted();
        const included = parseFolders(scope.includeFolders);
        const excluded = parseFolders(scope.excludeFolders);
        const within = (path: string, folder: string) => path.startsWith(folder + "/");
        const allowed = (file: TFile) =>
            (!included.length || included.some((folder) => within(file.path, folder))) &&
            !excluded.some((folder) => within(file.path, folder));
        const files = this.app.vault.getMarkdownFiles().filter(allowed);
        const total = files.length;
        const results: ScanResult[] = [];

        // Batch configuration to avoid blocking UI
        const BATCH_SIZE = 20;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            scope.signal?.throwIfAborted();
            const batch = files.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (file): Promise<ScanResult | null> => {
                if (!allowed(file)) return null;
                const path = file.path;
                const stat = file.stat;

                // Check cache
                const cached = this.cache.get(file.path);
                if (cached && cached.mtime === stat.mtime) {
                    return { file, highlights: cached.highlights, frontmatter: cached.frontmatter };
                }

                // Read and parse
                const content = await this.app.vault.cachedRead(file);
                scope.signal?.throwIfAborted();
                if (file.path !== path || !allowed(file)) return null;
                const highlights = getHighlightsFromContent(content);
                const metadata = this.app.metadataCache.getFileCache(file);
                const frontmatter = (metadata?.frontmatter as Record<string, unknown>) || {};

                // Update cache
                this.cache.set(file.path, {
                    mtime: stat.mtime,
                    highlights: highlights,
                    frontmatter: frontmatter,
                });

                return { file, highlights, frontmatter };
            });

            const batchResults = await Promise.all(batchPromises);

            for (const res of batchResults) {
                if (res && res.highlights.length > 0) {
                    results.push(res);
                }
            }

            // Report progress
            const current = Math.min(i + BATCH_SIZE, total);
            const lastFileName = batch[batch.length - 1].basename;
            onProgress(current, total, lastFileName);

            // Yield to main thread
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        scope.signal?.throwIfAborted();

        // Sort results by file name
        results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));

        return results.filter((result) => allowed(result.file));
    }

    /**
     * Clear the cache to force a full re-scan
     */
    clearCache(): void {
        this.cache.clear();
    }
}
