import { describe, it, expect, vi } from "vitest";
import { setup } from "./WritePath.test.js";
import { FloatingManager } from "../src/ui/FloatingManager";
import { renderHtml } from "./dom-helpers.js";

const raw = "Same footnote text.[^first][^second]\n\n[^first]: Same footnote text.\n\n[^second]: Same footnote text.";

async function popoverSetup(source = raw, html = "<p>Same footnote text.</p>") {
    const ctx = await setup(source, '<p>Same footnote text.<sup class="footnote-ref">1</sup></p>');
    const hoverEl = ctx.doc.body.createDiv({ cls: "popover hover-popover" });
    const containerEl = hoverEl.createDiv({ cls: "markdown-embed" });
    renderHtml(containerEl, html);
    const embed = { file: ctx.view.file, subpath: "#[^second]", containerEl, getMode: () => "preview" };
    ctx.view.previewMode = { hoverPopover: { hoverEl, embed } };
    ctx.plugin.app.metadataCache.getFileCache = () => ({
        embeds: [],
        footnotes: [
            {
                id: "second",
                position: {
                    start: { offset: ctx.out().indexOf("[^second]:") },
                    end: { offset: ctx.out().length },
                },
            },
        ],
    });
    ctx.plugin.handleSelectionFailure = vi.fn();
    ctx.plugin.floatingManager = new FloatingManager(ctx.plugin);
    ctx.plugin.floatingManager.load();
    const select = (selector = "p", word = "footnote") => {
        const element = containerEl.querySelector(selector);
        const node = element.firstChild;
        const start = node.nodeValue.indexOf(word);
        const range = ctx.doc.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + word.length);
        const selection = ctx.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        ctx.plugin.floatingManager.handleSelection();
        return { text: word, range };
    };
    return { ...ctx, hoverEl, containerEl, embed, select };
}

describe("footnote hover selection", () => {
    it("shows the toolbar and highlights only the hovered footnote through its button", async () => {
        const ctx = await popoverSetup();
        ctx.select();
        const manager = ctx.plugin.floatingManager;
        expect(manager.containerEl.style.display).toBe("flex");
        manager.highlightBtn.dispatchEvent(new ctx.window.MouseEvent("mousedown", { bubbles: true }));
        await vi.waitFor(() =>
            expect(ctx.out()).toBe(raw.replace("[^second]: Same footnote", "[^second]: Same ==footnote=="))
        );
        expect(ctx.plugin.handleSelectionFailure).not.toHaveBeenCalled();
    });

    it("applies and removes a colour through the existing keyboard command", async () => {
        const ctx = await popoverSetup();
        const commands = [];
        ctx.plugin.addCommand = (command) => commands.push(command);
        ctx.plugin.registerCommands();
        const command = commands.find((entry) => entry.id === "apply-color-3");
        ctx.select();
        expect(command.checkCallback(false)).toBe(true);
        await vi.waitFor(() =>
            expect(ctx.out()).toBe(raw.replace("[^second]: Same footnote", "[^second]: Same ==🟡footnote=="))
        );
        renderHtml(ctx.containerEl, "<p>Same <mark>footnote</mark> text.</p>");
        ctx.select("mark");
        command.checkCallback(false);
        await vi.waitFor(() => expect(ctx.out()).toBe(raw));
    });

    it("supports a later paragraph in the footnote", async () => {
        const source = "Text[^second].\n\n[^second]: First paragraph.\n\n    Later footnote paragraph.";
        const ctx = await popoverSetup(source, "<p>First paragraph.</p><p>Later footnote paragraph.</p>");
        await ctx.plugin.applyColorHighlight(ctx.view, "green", ctx.select("p:last-child"));
        expect(ctx.out()).toBe(source.replace("Later footnote", "Later ==🟢footnote=="));
    });

    it("preserves references to other named footnotes inside the popup", async () => {
        const source = raw + "[^first]";
        const ctx = await popoverSetup(source, '<p>Same footnote text.<sup class="footnote-ref">1</sup></p>');
        await ctx.plugin.applyColorHighlight(ctx.view, "red", ctx.select());
        expect(ctx.out()).toBe(source.replace("[^second]: Same footnote", "[^second]: Same ==🔴footnote=="));
    });

    it.each(["other file", "ordinary preview", "editing preview", "missing cache", "stale cache"])(
        "rejects %s without changing the note",
        async (reason) => {
            const ctx = await popoverSetup();
            if (reason === "other file") ctx.embed.file = { path: "other.md" };
            if (reason === "ordinary preview") ctx.embed.subpath = "#Heading";
            if (reason === "editing preview") ctx.embed.getMode = () => "source";
            if (reason === "missing cache") ctx.plugin.app.metadataCache.getFileCache = () => ({ footnotes: [] });
            if (reason === "stale cache")
                ctx.plugin.app.metadataCache.getFileCache = () => ({
                    footnotes: [
                        {
                            id: "second",
                            position: {
                                start: { offset: raw.indexOf("[^first]:") },
                                end: { offset: raw.indexOf("[^second]:") },
                            },
                        },
                    ],
                });
            const snapshot = ctx.select();
            if (reason !== "stale cache" && reason !== "missing cache")
                expect(ctx.plugin.floatingManager.containerEl.style.display).toBe("none");
            await ctx.plugin.applyColorHighlight(ctx.view, "red", snapshot);
            expect(ctx.out()).toBe(raw);
        }
    );
});
