import { describe, it, expect, vi } from "vitest";
import Plugin from "../src/main";
import { ResearchView } from "../src/views/ResearchView";
import { createObsidianWindow } from "./dom-helpers.js";

async function setup(settings = {}) {
    const win = createObsidianWindow();
    const read = [];
    const events = new Map();
    const file = { path: "Research/note.md", basename: "note", stat: { mtime: 1 } };
    const app = {
        vault: {
            on: (event, callback) => events.set(event, callback),
            getMarkdownFiles: () => [file],
            cachedRead: async () => {
                read.push(file.path);
                return "==Local research==";
            },
        },
        metadataCache: { getFileCache: () => ({}) },
        workspace: { getLeavesOfType: () => [{ view }] },
    };
    const plugin = new Plugin(app);
    plugin.loadData = async () => settings;
    plugin.floatingManager = { refresh() {} };
    await plugin.loadSettings();
    const view = new ResearchView({}, plugin);
    view.containerEl = win.document.createElement("div");
    view.containerEl.createDiv();
    view.containerEl.createDiv();
    await view.onOpen();
    return {
        plugin,
        view,
        read,
        rename: (path) => {
            const oldPath = file.path;
            file.path = path;
            events.get("rename")?.(file, oldPath);
        },
    };
}

describe("research view privacy", () => {
    it("does not scan notes on opening or restoring the view unless enabled", async () => {
        const { plugin, view, read } = await setup();
        expect(plugin.settings.researchAutoScan).toBe(false);
        expect(read).toEqual([]);
        expect(view.containerEl.textContent).toContain("Scan folders");
        [...view.containerEl.querySelectorAll("button")].find((b) => b.textContent === "Scan folders").click();
        await vi.waitFor(() => expect(view.scanResults[0]?.highlights[0].text).toBe("Local research"));
        expect(read).toEqual(["Research/note.md"]);
    });

    it("auto-scans only when the setting is explicitly true", async () => {
        const { view } = await setup({ researchAutoScan: true });
        await vi.waitFor(() => expect(view.scanResults[0]?.highlights[0].text).toBe("Local research"));
        const { read } = await setup({ researchAutoScan: "false" });
        expect(read).toEqual([]);
    });

    it("applies saved folder exclusions to manual scans", async () => {
        const { view, read } = await setup({ researchExcludedFolders: "Research" });
        await view.startScan();
        expect(view.scanResults).toEqual([]);
        expect(read).toEqual([]);
    });

    it("clears displayed and exportable results when folder settings change", async () => {
        const { plugin, view } = await setup();
        await view.startScan();
        expect(view.containerEl.textContent).toContain("Local research");
        plugin.settings.researchExcludedFolders = "Research";
        await plugin.saveSettings();
        expect(view.scanResults).toEqual([]);
        expect(view.collectHighlights()).toEqual([]);
        expect(view.containerEl.textContent).not.toContain("Local research");
    });

    it("discards an in-flight scan when its folder scope changes", async () => {
        const { plugin, view } = await setup();
        let finishRead;
        plugin.app.vault.cachedRead = () => new Promise((resolve) => (finishRead = resolve));
        const pending = view.startScan();
        plugin.settings.researchExcludedFolders = "Research";
        await plugin.saveSettings();
        finishRead("==Previously allowed text==");
        await pending;
        expect(view.scanResults).toEqual([]);
        expect(view.collectHighlights()).toEqual([]);
        expect(view.contentEl.textContent).toContain("Scan folders");
    });

    it("invalidates old results immediately even while saving settings is delayed", async () => {
        const { plugin, view } = await setup();
        await view.startScan();
        let finishSave;
        plugin.saveData = () => new Promise((resolve) => (finishSave = resolve));
        plugin.settings.researchExcludedFolders = "Research";
        const saving = plugin.saveSettings();
        expect(view.collectHighlights()).toEqual([]);
        expect(view.containerEl.textContent).not.toContain("Local research");
        finishSave();
        await saving;
    });

    it("clears displayed and exportable results when a note moves to an excluded folder", async () => {
        const { view, rename } = await setup({ researchExcludedFolders: "Private" });
        await view.startScan();
        expect(view.collectHighlights()[0].text).toBe("Local research");
        rename("Private/moved.md");
        expect(view.collectHighlights()).toEqual([]);
        expect(view.containerEl.textContent).not.toContain("Local research");
    });

    it.each(["rename", "close"])("does not restore resolved results after %s cancels the view", async (action) => {
        const { view, rename } = await setup();
        const results = await view.scanner.scanVault();
        let finishScan;
        view.scanner.scanVault = () => new Promise((resolve) => (finishScan = resolve));
        const pending = view.startScan();
        finishScan(results);
        if (action === "rename") rename("Private/moved.md");
        else void view.onClose();
        await pending;
        expect(view.scanResults).toEqual([]);
    });

    it("shows invalid folder settings as an error instead of scanning the whole vault", async () => {
        const { view, read } = await setup({ researchFolders: "../Private" });
        await view.startScan();
        expect(read).toEqual([]);
        expect(view.containerEl.textContent).toContain("vault-relative");
    });
});
