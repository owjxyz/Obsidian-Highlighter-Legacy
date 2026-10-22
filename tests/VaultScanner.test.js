import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultScanner } from "../src/core/VaultScanner";

describe("VaultScanner", () => {
    let mockApp;
    let scanner;

    beforeEach(() => {
        mockApp = {
            vault: {
                getMarkdownFiles: vi.fn(),
                cachedRead: vi.fn(),
            },
            metadataCache: {
                getFileCache: vi.fn().mockReturnValue({ frontmatter: {} }),
            },
        };
        scanner = new VaultScanner(mockApp);
    });

    it("scans files and groups highlights by file", async () => {
        const mockFile1 = { path: "file1.md", basename: "File 1", stat: { mtime: 1 } };
        const mockFile2 = { path: "file2.md", basename: "File 2", stat: { mtime: 1 } };

        mockApp.vault.getMarkdownFiles.mockReturnValue([mockFile1, mockFile2]);

        mockApp.vault.cachedRead.mockImplementation((file) => {
            if (file.path === "file1.md") {
                return Promise.resolve("Testing ==one== and <mark>two</mark>");
            }
            return Promise.resolve("Nothing here");
        });

        const results = await scanner.scanVault();

        expect(results.length).toBe(1);
        expect(results[0].file.path).toBe("file1.md");
        expect(results[0].highlights.length).toBe(2);
        expect(results[0].highlights[0].text).toBe("one");
        expect(results[0].highlights[1].text).toBe("two");
    });

    it("uses cache on subsequent scans if mtime is unchanged", async () => {
        const mockFile = { path: "test.md", basename: "Test", stat: { mtime: 100 } };

        mockApp.vault.getMarkdownFiles.mockReturnValue([mockFile]);
        mockApp.vault.cachedRead.mockResolvedValue("A ==highlight== here");

        // First scan
        await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(1);

        // Second scan (mtime identical)
        const results2 = await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(1); // Should NOT be called again
        expect(results2[0].highlights.length).toBe(1);

        // Update mtime and scan again
        mockFile.stat.mtime = 200;
        await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(2); // Should be called now
    });
});

describe("research folder boundaries", () => {
    function setup(paths) {
        const files = paths.map((path) => ({ path, basename: path, stat: { mtime: 1 } }));
        const read = [];
        const app = {
            vault: {
                getMarkdownFiles: () => files,
                cachedRead: async (file) => {
                    read.push(file.path);
                    return `==${file.path}==`;
                },
            },
            metadataCache: { getFileCache: () => ({}) },
        };
        return { scanner: new VaultScanner(app), read, files };
    }

    it("reads only included folders and their descendants, with exclusions taking priority", async () => {
        const { scanner, read } = setup([
            "Research/a.md",
            "Research/nested/b.md",
            "Research/private/secret.md",
            "Research archive/c.md",
            "Other/d.md",
        ]);
        const results = await scanner.scanVault(() => {}, {
            includeFolders: "Research",
            excludeFolders: "Research/private",
        });
        expect(results.map((r) => r.highlights[0].text)).toEqual(["Research/a.md", "Research/nested/b.md"]);
        expect(read).toEqual(["Research/a.md", "Research/nested/b.md"]);
    });

    it("normalizes multiline folder lists without losing Unicode or broadening a missing folder", async () => {
        const { scanner, read } = setup(["연구/하위/a.md", "Work/b.md", "Elsewhere/c.md"]);
        const results = await scanner.scanVault(() => {}, { includeFolders: "  연구\\하위/  \r\nWork\nMissing" });
        expect(results.map((r) => r.file.path)).toEqual(["Work/b.md", "연구/하위/a.md"]);
        expect(read).toEqual(["연구/하위/a.md", "Work/b.md"]);
        expect(await scanner.scanVault(() => {}, { includeFolders: "Missing" })).toEqual([]);
    });

    it("allows a manual whole-vault scan while still excluding private folders", async () => {
        const { scanner, read } = setup(["root.md", "Private/a.md", "Private copy/b.md"]);
        const results = await scanner.scanVault(() => {}, { includeFolders: " \n", excludeFolders: "Private/" });
        expect(results.map((r) => r.file.path)).toEqual(["Private copy/b.md", "root.md"]);
        expect(read).toEqual(["root.md", "Private copy/b.md"]);
    });

    it("does not return cached results outside a narrowed scope", async () => {
        const { scanner } = setup(["Public/a.md", "Private/b.md"]);
        await scanner.scanVault();
        const results = await scanner.scanVault(() => {}, { includeFolders: "Public" });
        expect(results.map((r) => r.file.path)).toEqual(["Public/a.md"]);
    });

    it("stops reading further batches when a scan is cancelled", async () => {
        const { scanner, read } = setup(Array.from({ length: 21 }, (_, i) => `Research/${i}.md`));
        const controller = new AbortController();
        await expect(scanner.scanVault(() => controller.abort(), { signal: controller.signal })).rejects.toThrow();
        expect(read).not.toContain("Research/20.md");
    });

    it("does not read a later-batch note moved into an excluded folder", async () => {
        const { scanner, read, files } = setup(Array.from({ length: 21 }, (_, i) => `Research/${i}.md`));
        const results = await scanner.scanVault(
            () => {
                files[20].path = "Private/moved.md";
            },
            { excludeFolders: "Private" }
        );
        expect(read).not.toContain("Private/moved.md");
        expect(results).toHaveLength(20);
    });

    it("drops a note moved outside scope while its contents are being read", async () => {
        const { scanner, files } = setup(["Research/a.md"]);
        scanner.app.vault.cachedRead = async () => {
            files[0].path = "Private/moved.md";
            return "==Previously allowed text==";
        };
        expect(await scanner.scanVault(() => {}, { includeFolders: "Research" })).toEqual([]);
    });

    it.each(["../Private", "/Research", "Research/../Private", "C:\\Research", ".", 7])(
        "rejects invalid folder setting %s before reading any note",
        async (includeFolders) => {
            const { scanner, read } = setup(["Private/a.md"]);
            await expect(scanner.scanVault(() => {}, { includeFolders })).rejects.toThrow("vault-relative");
            expect(read).toEqual([]);
        }
    );
});
