import { describe, it, expect, vi } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { FloatingManager } from "../src/ui/FloatingManager";
import { HighlightNavigatorView } from "../src/views/HighlightNavigator";
import { HighlightEditModal } from "../src/modals/HighlightEditModal";
import { parseHighlights } from "../src/utils/highlights";
import { MarkdownView } from "./obsidian-stub.js";
import { setup, highlightRange } from "./WritePath.test.js";

const legacy = {
    semanticColors: [{ color: "red", meaning: "Important" }],
    showOnlyAssignedColors: true,
    defaultTagPrefix: "book",
    enableFrontmatterTag: true,
    frontmatterTag: "highlighted",
    showTagButton: true,
    showQuoteButton: true,
    enableAnnotations: true,
    showAnnotationButton: true,
    enableSmartTagSuggestions: true,
    recentTags: ["old"],
    maxRecentTags: 10,
    quoteTemplate: "> {{text}}",
    enableReadingProgress: true,
    readingPositions: { "note.md": 400 },
    researchAutoScan: true,
    researchFolders: "Books",
    researchExcludedFolders: "Private",
};

describe("highlight-only feature boundary", () => {
    it("drops retired settings while preserving highlight settings on upgrade", async () => {
        const plugin = new ReadingHighlighterPlugin({}, {});
        plugin.loadData = async () => ({ ...legacy, defaultHighlightColor: "green", toolbarPosition: "left" });
        await plugin.loadSettings();
        for (const key of Object.keys(legacy)) expect(plugin.settings).not.toHaveProperty(key);
        expect(plugin.settings).toMatchObject({ defaultHighlightColor: "green", toolbarPosition: "left" });
    });

    it("registers only highlight commands and settings, with no scroll tracking", async () => {
        const ctx = await setup("text", "<p>text</p>");
        const plugin = ctx.plugin;
        const commands = [];
        let settingsTab;
        plugin.addCommand = (command) => commands.push(command.id);
        plugin.addSettingTab = (tab) => {
            settingsTab = tab;
        };
        const registerDomEvent = vi.spyOn(plugin, "registerDomEvent");
        await plugin.onload();
        expect(commands).toEqual([
            "highlight-selection-reading",
            "remove-highlight",
            "undo-last-highlight",
            "open-highlight-navigator",
            "remove-all-highlights",
            "merge-adjacent-highlights",
            "recolor-highlights",
            "convert-html-highlights",
            ...Array.from({ length: 6 }, (_, i) => `apply-color-${i + 1}`),
        ]);
        const definitions = JSON.stringify(settingsTab.getSettingDefinitions());
        for (const key of Object.keys(legacy)) expect(definitions).not.toContain(`"${key}"`);
        expect(registerDomEvent.mock.calls.some(([, event]) => event === "scroll")).toBe(false);
        plugin.onunload();
    });

    it("shows only highlight, colour and remove controls and stays hidden in PDFs", async () => {
        const ctx = await setup("text", "<p>text</p>");
        Object.assign(ctx.plugin.settings, legacy, { enableColorPalette: true, showTooltips: true });
        const manager = new FloatingManager(ctx.plugin);
        manager.load();
        expect(
            [...manager.containerEl.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
        ).toEqual(["Highlight selection", "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Remove highlights"]);
        const node = ctx.content.querySelector("p").firstChild;
        const range = ctx.doc.createRange();
        range.selectNodeContents(node);
        ctx.window.getSelection().addRange(range);
        const pdf = { containerEl: ctx.content, getViewType: () => "pdf" };
        ctx.plugin.app.workspace.getActiveViewOfType = (type) => (type === MarkdownView ? null : pdf);
        manager.handleSelection();
        expect(manager.containerEl.style.display).toBe("none");
        manager.unload();
    });

    it("keeps the navigator limited to highlights and bulk actions", async () => {
        const ctx = await setup("==text==[^n]\n\n[^n]: comment", "<p><mark>text</mark></p>");
        ctx.plugin.app.vault.on = () => {};
        const navigator = new HighlightNavigatorView({}, ctx.plugin);
        navigator.app = ctx.plugin.app;
        navigator.containerEl = ctx.doc.createElement("div");
        navigator.containerEl.append(ctx.doc.createElement("div"), ctx.doc.createElement("div"));
        await navigator.onOpen();
        await navigator.refresh(true);
        expect([...navigator.containerEl.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
            "⋯",
            "Bulk",
        ]);
        expect(navigator.containerEl.textContent).not.toMatch(/Footnotes|Both|Export|Canvas|Scan|comment/);
        expect(navigator.highlights).toHaveLength(1);
    });

    it("does not add tags or mutate existing frontmatter and footnotes when highlighting", async () => {
        const raw = "---\ntags: [existing]\n---\n#saved\n\nalpha beta[^n].\n\n[^n]: Keep me.\n";
        const ctx = await setup(raw, '<p>#saved</p><p>alpha beta<sup class="footnote-ref">1</sup>.</p>');
        Object.assign(ctx.plugin.settings, legacy);
        const frontmatter = vi.spyOn(ctx.plugin.app.fileManager, "processFrontMatter");
        const node = ctx.content.querySelectorAll("p")[1].firstChild;
        await highlightRange(ctx, node, 0, node, 5);
        expect(ctx.out()).toBe(raw.replace("alpha", "==alpha=="));
        expect(frontmatter).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "preserves existing tags and footnotes when editing a highlight (remove: %s)",
        async (remove) => {
            const raw = "#saved ==🟡alpha[^n]== beta.\n\n[^n]: Keep me.\n";
            const ctx = await setup(raw, "<p>alpha beta.</p>");
            const [highlight] = parseHighlights(raw).highlights;
            const modal = new HighlightEditModal(ctx.plugin, ctx.view.file, highlight.id);
            modal.app = ctx.plugin.app;
            modal.close = () => {};
            modal.state.color = "green";
            await modal.applyEdits({ remove });
            expect(ctx.out()).toBe(remove ? raw.replace("==🟡alpha[^n]==", "alpha[^n]") : raw.replace("🟡", "🟢"));
            await ctx.plugin.undoLastHighlight();
            expect(ctx.out()).toBe(raw);
        }
    );
});
