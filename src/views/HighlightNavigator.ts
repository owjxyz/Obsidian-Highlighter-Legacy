import {
    ItemView,
    MarkdownView,
    Menu,
    MenuItem,
    Notice,
    Platform,
    WorkspaceLeaf,
    TFile,
    TAbstractFile,
} from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import type { Highlight } from "../utils/highlights";
import { parseHighlights, findHighlightById, removeHighlightFromRaw } from "../utils/highlights";
import { HighlightEditModal } from "../modals/HighlightEditModal";
import { BulkRecolorModal } from "../modals/BulkRecolorModal";

export const HIGHLIGHT_NAVIGATOR_VIEW = "superior-highlighter-navigator";

/** Highlights in the current note, with search and bulk actions. */
export class HighlightNavigatorView extends ItemView {
    plugin: ReadingHighlighterPlugin;
    highlights: Highlight[];
    currentFile: TFile | null;
    searchQuery: string;

    constructor(leaf: WorkspaceLeaf, plugin: ReadingHighlighterPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.highlights = [];
        this.currentFile = null;
        this.searchQuery = ""; // Search filter
    }

    getViewType() {
        return HIGHLIGHT_NAVIGATOR_VIEW;
    }

    getDisplayText() {
        return "Highlights";
    }

    getIcon() {
        return "highlighter";
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("highlight-navigator-container");

        // Search Bar
        const searchContainer = container.createDiv({ cls: "highlight-navigator-search" });
        const searchInput = searchContainer.createEl("input", {
            type: "text",
            placeholder: "Search...",
            cls: "nav-search-input",
        });
        searchInput.oninput = (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
            this.renderContent();
        };

        // Content area
        this.contentEl = container.createDiv({ cls: "highlight-navigator-content" });

        const footer = container.createDiv({ cls: "highlight-navigator-footer" });
        const footerBtnGroup = footer.createDiv({ cls: "highlight-navigator-footer-buttons" });

        const bulkBtn = footerBtnGroup.createEl("button", { text: "Bulk", cls: "mod-cta" });
        bulkBtn.onclick = (e) => this.openBulkMenu(e);

        // Register for file changes
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                void this.refresh();
            })
        );

        this.registerEvent(
            this.app.vault.on("modify", (file: TAbstractFile) => {
                if (this.currentFile && file.path === this.currentFile.path) {
                    void this.refresh(true);
                }
            })
        );

        void this.refresh();
    }

    async refresh(force = false) {
        let targetFile: TFile | null;

        if (force) {
            // Forced refresh (after an edit/removal, or on a modify event):
            // re-read the file we're already showing. Interacting with this
            // sidebar makes it the active leaf, so there may be no active
            // MarkdownView to read from — fall back to currentFile.
            targetFile = this.currentFile || this.app.workspace.getActiveViewOfType(MarkdownView)?.file || null;
            if (!targetFile) {
                return;
            }
        } else {
            // Following the active note (e.g. user switched files).
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            // Prevent wiping list on brief focus loss
            if (!view || !view.file) {
                return;
            }

            // Only re-parse if the file actually changed.
            if (this.currentFile && view.file.path === this.currentFile.path) {
                return;
            }

            targetFile = view.file;
        }

        this.currentFile = targetFile;

        try {
            const raw = await this.app.vault.read(targetFile);
            this.highlights = parseHighlights(raw).highlights;
            this.renderContent();
        } catch (err) {
            this.showEmpty("Error loading content.");
            console.error(err);
        }
    }

    showEmpty(message: string, container: HTMLElement = this.contentEl) {
        container.empty();
        container.createDiv({ cls: "highlight-navigator-empty", text: message });
    }

    stripMarkdown(text: string): string {
        if (!text) return "";
        return text
            .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1") // [[Link]] or [[Link|Alias]] -> Link/Alias
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [Link](URL) -> Link
            .replace(/[*_~`]+/g, ""); // Bold, Italics, Strikethrough, Code
    }

    renderContent() {
        this.contentEl.empty();
        this.renderList(this.contentEl, this.highlights);
    }

    renderList(container: HTMLElement, items: Highlight[]) {
        // Filter items based on search query
        const filteredItems = items.filter((item) => {
            if (!this.searchQuery) return true;
            return item.text.toLowerCase().includes(this.searchQuery);
        });

        if (filteredItems.length === 0) {
            if (this.searchQuery) {
                this.showEmpty(`No matches for "${this.searchQuery}".`, container);
            } else {
                this.showEmpty("No highlights found.", container);
            }
            return;
        }

        const stats = container.createDiv({ cls: "highlight-navigator-stats" });

        let statsText = `${filteredItems.length} highlights`;
        if (this.searchQuery && filteredItems.length !== items.length) {
            statsText += ` (filtered from ${items.length})`;
        }
        stats.createSpan({ text: statsText });

        const list = container.createDiv({ cls: "highlight-navigator-list" });
        const fragment = createFragment();

        filteredItems.forEach((item, index) => {
            const el = fragment.createDiv({ cls: "highlight-navigator-item" });

            el.createSpan({
                cls: item.color
                    ? "highlight-color-dot highlight-swatch reading-highlighter-swatch"
                    : "highlight-color-dot highlight-default",
                attr: item.color ? { "data-highlight": item.color } : {},
            });

            const textSpan = el.createSpan({ cls: "highlight-text" });
            textSpan.textContent = this.stripMarkdown(item.text);

            const openMenu = (e: MouseEvent) => this.openHighlightActionsMenu(item, e);

            const menuBtn = el.createEl("button", { cls: "highlight-item-menu" });
            menuBtn.setAttribute("aria-label", "Highlight actions");
            menuBtn.textContent = "⋯";
            menuBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(e);
            };

            const numberBadge = el.createSpan({ cls: "highlight-number" });
            numberBadge.textContent = `${index + 1}`;

            el.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(e);
            };

            el.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                void this.jumpToLine(item.line);
            };
        });

        list.appendChild(fragment);
    }

    async copyItemText(item: Highlight) {
        const text = (item?.text ?? "").trim();
        if (!text) {
            new Notice("Nothing to copy.");
            return;
        }
        const ok = await this.plugin.writeClipboardText(text);
        new Notice(ok ? "Copied to clipboard." : "Failed to copy.");
    }

    openHighlightActionsMenu(item: Highlight, event: MouseEvent) {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Copy")
                .setIcon("copy")
                .onClick(() => void this.copyItemText(item));
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Edit…")
                .setIcon("pencil")
                .onClick(() => {
                    new HighlightEditModal(this.plugin, currentFile, item.id, () => {
                        void this.refresh(true);
                    }).open();
                });
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove highlight")
                .setIcon("trash-2")
                .onClick(() => void this.removeSingleHighlight(item));
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove all highlights (note)")
                .setIcon("eraser")
                .setWarning(true)
                .onClick(async () => {
                    await this.plugin.removeAllHighlightsInFile(currentFile);
                    await this.refresh(true);
                });
        });

        menu.showAtMouseEvent(event);
    }

    /**
     * Delete one highlight, leaving its text in place. Removing a single
     * highlight previously meant opening the edit modal, which is several taps
     * for the most common cleanup there is.
     */
    async removeSingleHighlight(item: Highlight) {
        const currentFile = this.currentFile;
        if (!currentFile) return;
        try {
            await this.plugin.saveUndoState(currentFile);
            let found = false;
            const result = await this.app.vault.process(currentFile, (data) => {
                const highlight = findHighlightById(parseHighlights(data), item.id);
                if (!highlight) return data;
                found = true;
                return removeHighlightFromRaw(data, highlight);
            });
            if (found) await this.plugin.recordUndoResult(currentFile, result);
            if (!found) {
                new Notice("Highlight not found (it may have moved).");
            }
            await this.refresh(true);
        } catch (err) {
            console.error("Superior Highlighter: failed to remove highlight.", err);
            new Notice("Failed to remove highlight.");
        }
    }

    openBulkMenu(event: MouseEvent) {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Merge adjacent highlights (note)")
                .setIcon("git-merge")
                .onClick(async () => {
                    await this.plugin.mergeAdjacentHighlightsInFile(currentFile);
                    void this.refresh(true);
                });
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Recolour highlights (note)…")
                .setIcon("palette")
                .onClick(() => {
                    new BulkRecolorModal(this.plugin, currentFile, () => {
                        void this.refresh(true);
                    }).open();
                });
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Convert HTML highlights to native (note)")
                .setIcon("wand")
                .onClick(async () => {
                    await this.plugin.convertHtmlHighlightsInFile(currentFile);
                    void this.refresh(true);
                });
        });

        menu.showAtMouseEvent(event);
    }

    async jumpToLine(line: number) {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf && leaf.view instanceof MarkdownView) {
            leaf.setEphemeralState({
                line: line,
                focus: true,
            });
        }
        this.collapseSidebarOnMobile();
    }

    collapseSidebarOnMobile() {
        if (!Platform.isMobile) return;
        const root = this.leaf.getRoot();
        if (root === this.app.workspace.leftSplit) {
            this.app.workspace.leftSplit.collapse();
        } else if (root === this.app.workspace.rightSplit) {
            this.app.workspace.rightSplit.collapse();
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}
