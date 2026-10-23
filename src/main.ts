import {
    App,
    Plugin,
    Notice,
    Platform,
    PluginSettingTab,
    Setting,
    MarkdownView,
    TFile,
    type Command,
    type SettingDefinitionItem,
} from "obsidian";
import { FloatingManager, type SelectionSnapshot } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { HighlightNavigatorView, HIGHLIGHT_NAVIGATOR_VIEW } from "./views/HighlightNavigator";
import { getScroll, applyScroll, type ScrollPosition } from "./utils/dom";
import { FailureRecoveryModal, type DerivedRule } from "./ui/FailureRecoveryModal";
import {
    parseHighlights,
    mergeAdjacentHighlightsInRaw,
    convertHtmlHighlightsInRaw,
    recolorHighlightsInRaw,
    removeAllHighlightsFromRaw,
    type RecolorSource,
} from "./utils/highlights";
import {
    COLOR_LABELS,
    HIGHLIGHT_COLORS,
    isHighlightColor,
    nearestHighlightColor,
    type HighlightColor,
} from "./utils/colors";
import { getSelectedOccurrence, readBlockTextAndCaret, type SelectionHint } from "./utils/blockOccurrence";
import { kindForElement, type BlockKind } from "./utils/sourceBlocks";
import { editHighlightRange } from "./utils/preciseHighlight";
import { BulkRecolorModal } from "./modals/BulkRecolorModal";

interface LearnedNormRule {
    stripPattern: string;
}

/** Settings written by versions that coloured highlights with HTML. */
interface LegacyColorSettings {
    enableColorHighlighting?: boolean;
    highlightColor?: string;
}

interface ReadingHighlighterSettings {
    toolbarPosition: string;
    /** Colour the plain highlight button writes; empty for the theme's default. */
    defaultHighlightColor: HighlightColor | "";
    enableHaptics: boolean;
    showRemoveButton: boolean;
    enableColorPalette: boolean;
    showNavigatorButton: boolean;
    showTooltips: boolean;
    enableSmartParagraphSelection: boolean;
    learnedNormRules: LearnedNormRule[];
}

const SMART_SELECTION_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"]);

const DEFAULT_SETTINGS: ReadingHighlighterSettings = {
    toolbarPosition: "text",
    defaultHighlightColor: "",
    enableHaptics: true,
    showRemoveButton: true,
    enableColorPalette: true,
    showNavigatorButton: true,
    showTooltips: false,
    enableSmartParagraphSelection: false,
    learnedNormRules: [],
};

/** What `SelectionLogic.locateSelection` resolves a selection to. */
interface LocatedRange {
    file: TFile;
    start: number;
    end: number;
    raw: string;
}

interface SelectionRequest {
    snippet: string;
    contextElement: HTMLElement | null;
    blocks: HTMLElement[];
    range: Range | null;
    contextText: string | null;
    occurrenceIndex: number;
    withinBlock: SelectionHint | null;
    contextKind: BlockKind | null;
}

export default class ReadingHighlighterPlugin extends Plugin {
    settings: ReadingHighlighterSettings;
    floatingManager: FloatingManager;
    logic: SelectionLogic;
    /**
     * What "Undo last highlight" restores. `after` is the note as the plugin
     * left it; undo refuses once the note no longer reads that way, since
     * restoring `original` would throw away whatever was written since.
     */
    lastModification: { file: TFile; original: string; after?: string } | null = null;
    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app, () => this.settings.learnedNormRules);

        this.registerView(HIGHLIGHT_NAVIGATOR_VIEW, (leaf) => new HighlightNavigatorView(leaf, this));

        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));
        this.registerCommands();

        // Preferences may have focus when the plugin is enabled.
        this.registerWindowEvents(this.floatingManager.targetDocument());
        // A popout window has a document of its own, which fires its own
        // selection events.
        this.registerEvent(this.app.workspace.on("window-open", (win) => this.registerWindowEvents(win.doc)));

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
            })
        );

        if (Platform.isMobile) {
            const btn = this.addRibbonIcon("highlighter", "Highlight selection", () => {
                const view = this.getActiveReadingView();
                if (view) void this.highlightSelection(view);
                else new Notice("Open a note in reading view first.");
            });
            this.register(() => btn.remove());
        }

        this.addRibbonIcon("highlighter", "Highlight navigator", () => {
            void this.activateNavigatorView();
        });

        this.floatingManager.load();
    }

    registerCommands() {
        this.addCommand({
            id: "highlight-selection-reading",
            name: "Toggle highlight selection",
            checkCallback: (checking) => {
                if (this.checkEditorHighlight(checking)) return true;
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.highlightSelection(view, null, true);
                return true;
            },
        });

        this.addCommand({
            id: "remove-highlight",
            name: "Remove highlight from selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.removeHighlightSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "undo-last-highlight",
            name: "Undo last highlight",
            callback: () => {
                void this.undoLastHighlight();
            },
        });

        this.addCommand({
            id: "open-highlight-navigator",
            name: "Open highlight navigator",
            callback: () => {
                void this.activateNavigatorView();
            },
        });

        this.addCommand({
            id: "remove-all-highlights",
            name: "Remove all highlights from note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.removeAllHighlights(view);
                return true;
            },
        });

        this.addCommand({
            id: "merge-adjacent-highlights",
            name: "Merge adjacent highlights in note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.mergeAdjacentHighlightsInFile(view.file);
                return true;
            },
        });

        this.addCommand({
            id: "recolor-highlights",
            name: "Recolour highlights in note…",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                new BulkRecolorModal(this, view.file).open();
                return true;
            },
        });

        this.addCommand({
            id: "convert-html-highlights",
            name: "Convert HTML highlights to native highlights in note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.convertHtmlHighlightsInFile(view.file);
                return true;
            },
        });

        // The ids keep their old numbering, so hotkeys bound to the first six
        // still work; each now names the native colour it applies.
        HIGHLIGHT_COLORS.forEach((color, i) => {
            this.addCommand({
                id: `apply-color-${i + 1}`,
                name: `Toggle ${COLOR_LABELS[color].toLowerCase()} highlight`,
                checkCallback: (checking) => {
                    if (this.checkEditorHighlight(checking, color)) return true;
                    const view = this.getActiveReadingView();
                    if (!view) return false;
                    if (checking) return true;
                    void this.applyColorByIndex(view, i, null, true);
                    return true;
                },
            });
        });
    }

    checkEditorHighlight(checking: boolean, color?: HighlightColor): boolean {
        // Obsidian wraps native editor commands with its own mode and focus checks.
        const { commands } = this.app as App & {
            commands?: { findCommand(id: string): Command | undefined };
        };
        const id = color ? `editor:toggle-highlight-${color}` : "editor:toggle-highlight";
        return !!commands?.findCommand(id)?.checkCallback?.(checking);
    }

    onunload() {
        this.floatingManager.unload();
    }

    registerWindowEvents(doc: Document) {
        this.registerDomEvent(doc, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });
    }

    async loadSettings() {
        const loaded = ((await this.loadData()) as Partial<ReadingHighlighterSettings> & LegacyColorSettings) || {};
        const { enableColorHighlighting, highlightColor } = loaded;
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            Object.fromEntries(Object.entries(loaded).filter(([key]) => Object.hasOwn(DEFAULT_SETTINGS, key)))
        );
        if (!isHighlightColor(this.settings.defaultHighlightColor)) {
            // A default colour chosen when highlights were HTML becomes the
            // nearest native one.
            this.settings.defaultHighlightColor =
                (enableColorHighlighting && nearestHighlightColor(highlightColor)) || "";
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.floatingManager.refresh();
    }

    getActiveReadingView(): MarkdownView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view && view.getMode() === "preview" ? view : null;
    }

    getSelectionScope(view: MarkdownView, node: Node) {
        if (view.contentEl.contains(node)) return { root: view.contentEl, footnoteId: undefined };
        for (const popover of [view.previewMode?.hoverPopover, view.hoverPopover]) {
            // Page Preview owns the embed; only accept a reading preview of this note's footnote.
            const embed = (popover as typeof popover & { embed?: MarkdownView & { subpath?: string } })?.embed;
            const footnoteId = embed?.subpath?.match(/^#\[\^([^\]]+)\]$/)?.[1];
            if (
                footnoteId &&
                embed?.file?.path === view.file?.path &&
                embed.getMode() === "preview" &&
                popover?.hoverEl.contains(node) &&
                embed.containerEl.contains(node)
            ) {
                return { root: embed.containerEl, footnoteId };
            }
        }
        return null;
    }

    getSelectionContext(selectionSnapshot: SelectionSnapshot | null) {
        const view = this.getActiveReadingView();
        const range = this.getSelectionRange(selectionSnapshot);
        if (!view || !range) return null;

        const scope = this.getSelectionScope(view, range.commonAncestorContainer);
        if (!scope) return null;
        const blocks = this.getAllowedBlocksInRange(range, scope.root);
        const fallbackBlock = this.getClosestAllowedBlock(range.commonAncestorContainer, scope.root);
        const contextElement = blocks[0] || fallbackBlock || null;
        const rawSnippet = selectionSnapshot?.text || window.getSelection()?.toString() || "";

        let snippet = rawSnippet;
        if (this.settings.enableSmartParagraphSelection && blocks.length === 1) {
            const blockText = this.getElementText(blocks[0]);
            if (blockText) {
                snippet = blockText;
            }
        }

        return {
            element: contextElement,
            blocks,
            snippet,
            text: contextElement ? this.getElementText(contextElement) : null,
        };
    }

    getSelectionRange(selectionSnapshot: SelectionSnapshot | null | undefined): Range | null {
        if (selectionSnapshot?.range) {
            return selectionSnapshot.range.cloneRange();
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }
        return selection.getRangeAt(0).cloneRange();
    }

    getAllowedBlocksInRange(range: Range, root: HTMLElement) {
        if (!root) return [];
        const selector = Array.from(SMART_SELECTION_TAGS)
            .map((tag) => tag.toLowerCase())
            .join(", ");
        const blocks = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
            const text = this.getElementText(element);
            if (!text) return false;
            try {
                if (!range.intersectsNode(element)) return false;
                const portion = this.intersectRangeWithBlock(range, element);
                return !!portion && !!getSelectedOccurrence(element, portion, portion.toString());
            } catch {
                return false;
            }
        });
        // A paragraph inside a list item belongs to that item, but a nested
        // item owns a separate source block and must keep its own anchor.
        return blocks.filter(
            (element) =>
                !blocks.some(
                    (other) =>
                        other !== element && other.contains(element) && other.closest("li") === element.closest("li")
                )
        );
    }

    getClosestAllowedBlock(node: Node, root: HTMLElement): HTMLElement | null {
        let current = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement;
        while (current && current !== root) {
            if (SMART_SELECTION_TAGS.has(current.tagName) && this.getElementText(current)) {
                return current;
            }
            current = current.parentElement;
        }
        return current && SMART_SELECTION_TAGS.has(current.tagName) ? current : null;
    }

    getElementText(element: HTMLElement) {
        return readBlockTextAndCaret(element, { startContainer: element, startOffset: 0 })?.text ?? "";
    }

    buildSelectionRequest(view: MarkdownView, selectionSnapshot: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const selectionContext = this.getSelectionContext(selectionSnapshot);
        const snippet = selectionContext?.snippet || selectionSnapshot?.text || sel?.toString() || "";
        if (!snippet.trim()) {
            return null;
        }
        const contextElement = selectionContext?.element || null;
        const hint = this.getWithinBlockHint(contextElement, selectionSnapshot, snippet);
        if (!hint) {
            new Notice("The selected element has no reliable text position. The note was not changed.");
            return null;
        }
        return {
            snippet,
            contextElement,
            blocks: selectionContext?.blocks || [],
            range: this.getSelectionRange(selectionSnapshot),
            contextText: contextElement ? this.getElementText(contextElement) : null,
            occurrenceIndex: this.getSelectionOccurrence(view, contextElement, hint),
            withinBlock: hint,
            contextKind: kindForElement(contextElement),
        };
    }

    /**
     * Which occurrence of `snippet` inside `contextElement` the caret is on.
     *
     * `getSelectionOccurrence` distinguishes repeated *blocks*; this
     * distinguishes repeats *within* one block, which is what a paragraph
     * containing soft line breaks (Shift+Enter) produces — one <p>, one context
     * string, several identical snippets. Returns null when there is no live
     * range to read, leaving the matcher on its previous first-match behaviour.
     */
    getWithinBlockHint(
        contextElement: HTMLElement | null,
        selectionSnapshot: SelectionSnapshot | null,
        snippet: string
    ): SelectionHint | null {
        if (!contextElement) return null;
        const range = this.getSelectionRange(selectionSnapshot);
        if (!range) return null;
        return getSelectedOccurrence(contextElement, range, snippet);
    }

    getSelectionOccurrence(view: MarkdownView, contextElement: HTMLElement | null, hint?: SelectionHint | null) {
        if (!contextElement) return 0;
        const scope = this.getSelectionScope(view, contextElement);
        if (!scope) return -1;
        if (hint && scope.footnoteId) hint.footnoteId = scope.footnoteId;
        const contextText = this.getElementText(contextElement);
        const matching = [...scope.root.querySelectorAll<HTMLElement>(contextElement.tagName.toLowerCase())].filter(
            (element) => this.getElementText(element) === contextText
        );
        if (hint) hint.blockTotal = matching.length;
        return matching.indexOf(contextElement);
    }

    async saveUndoState(file: TFile) {
        this.lastModification = {
            file: file,
            original: await this.app.vault.read(file),
        };
    }

    /** Record the note as a change left it, so undo can tell if it was edited since. */
    async recordUndoResult(file: TFile, content?: string) {
        const last = this.lastModification;
        if (!last || last.file !== file) return;
        last.after = content ?? (await this.app.vault.read(file));
    }

    async undoLastHighlight() {
        const last = this.lastModification;
        // Without a recorded result the change was never written, so there is
        // nothing to undo.
        if (!last || last.after === undefined) {
            new Notice("Nothing to undo.");
            return;
        }
        try {
            const current = await this.app.vault.read(last.file);
            if (current !== last.after) {
                new Notice("The note has changed since, so undoing would lose those changes.");
                return;
            }
            await this.app.vault.modify(last.file, last.original);
            new Notice("Undone last highlight.");
            this.lastModification = null;
        } catch (err) {
            new Notice("Failed to undo.");
            console.error(err);
        }
    }

    /**
     * The portion of `range` that falls inside `block`, as its own range.
     * Blocks in the middle of a selection are covered entirely; the first and
     * last are usually partial.
     */
    intersectRangeWithBlock(range: Range, block: HTMLElement): Range | null {
        try {
            const blockRange = block.ownerDocument.createRange();
            blockRange.selectNodeContents(block);
            if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) > 0) {
                blockRange.setStart(range.startContainer, range.startOffset);
            }
            if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) < 0) {
                blockRange.setEnd(range.endContainer, range.endOffset);
            }
            return blockRange.collapsed ? null : blockRange;
        } catch {
            return null;
        }
    }

    /**
     * Locate the portion of the selection that lies in `block`.
     */
    async locateBlockPortion(view: MarkdownView, range: Range, block: HTMLElement): Promise<LocatedRange | null> {
        const blockRange = this.intersectRangeWithBlock(range, block);
        if (!blockRange) return null;
        const snippet = blockRange.toString();
        if (!snippet.trim()) return null;
        const hint = getSelectedOccurrence(block, blockRange, snippet);
        if (!hint) return null;
        return this.logic.locateSelection(
            view.file,
            view,
            snippet,
            this.getElementText(block),
            this.getSelectionOccurrence(view, block, hint),
            hint,
            kindForElement(block)
        );
    }

    /**
     * Handle a selection spanning several blocks.
     *
     * Matching the whole article as one snippet fails: it asks the engine to
     * align thousands of characters of rendered text — across headings, list
     * markers, footnote references and existing highlights — against the source
     * in one pass, and the user gets the recovery dialog instead of a highlight.
     *
     * A multi-block selection is contiguous, though, so only its two ends need
     * locating. Anchor on the first and last blocks and apply a single edit
     * across the span between them; `applyMarkdownModification` already walks a
     * multi-line range line by line, keeping each line's `- ` or `#` prefix
     * outside its highlight. Locating every block instead would be O(blocks)
     * whole-file scans — minutes of frozen UI on a long article.
     */
    async highlightSpanningBlocks(view: MarkdownView, request: SelectionRequest, mode: string, payload: string) {
        if (!request.range || !view.file) return false;
        const blocks = request.blocks;

        const head = await this.locateBlockPortion(view, request.range, blocks[0]);
        if (!head) return false;
        const tail = await this.locateBlockPortion(view, request.range, blocks[blocks.length - 1]);
        if (!head || !tail || head.file.path !== tail.file.path) return false;

        const start = Math.min(head.start, tail.start);
        const end = Math.max(head.end, tail.end);
        if (end <= start) return false;

        await this.saveUndoState(head.file);
        if (head.raw !== tail.raw) return false;
        const embeds = this.app.metadataCache.getFileCache(head.file)?.embeds ?? [];
        if (embeds.some((embed) => embed.position.start.offset < end && embed.position.end.offset > start))
            return false;
        return this.applyMarkdownModification(head.file, head.raw, start, end, mode, payload);
    }

    async highlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null, toggle = false) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const scrollPos = getScroll(view);

        const mode = toggle ? "toggle-highlight" : "highlight";
        const payload = "";

        // A selection spanning several blocks is handled one block at a time.
        // Matching a whole article as a single snippet asks the engine to align
        // thousands of characters of rendered text — across headings, list
        // markers, footnote references and existing highlights — against the
        // source in one go, and it simply fails, leaving the user with the
        // recovery dialog. Each block on its own matches reliably.
        if (request.blocks.length > 1) {
            const ok = await this.highlightSpanningBlocks(view, request, mode, payload);
            if (!ok) {
                this.handleSelectionFailure(view, request, "highlightSelection");
                return;
            }
            this.restoreScroll(view, scrollPos);
            sel?.removeAllRanges();
            new Notice("Highlighted!");
            return;
        }

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "highlightSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        if (!(await this.applyMarkdownModification(targetFile, result.raw, result.start, result.end, mode, payload)))
            return;
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();

        if (this.settings.enableHaptics && Platform.isMobile) {
            navigator.vibrate?.(10);
        }
        new Notice("Highlighted!");
    }

    async applyColorByIndex(
        view: MarkdownView,
        index: number,
        selectionSnapshot?: SelectionSnapshot | null,
        toggle = false
    ) {
        if (!Number.isInteger(index) || index < 0 || index >= HIGHLIGHT_COLORS.length) return;
        await this.applyColorHighlight(view, HIGHLIGHT_COLORS[index], selectionSnapshot, toggle);
    }

    async removeHighlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("Select highlighted text to remove.");
            return;
        }
        const scrollPos = getScroll(view);
        if (request.blocks.length > 1) {
            if (!(await this.highlightSpanningBlocks(view, request, "remove", ""))) {
                this.handleSelectionFailure(view, request, "removeHighlightSelection");
                return;
            }
            this.restoreScroll(view, scrollPos);
            sel?.removeAllRanges();
            return;
        }

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "removeHighlightSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);
        if (!(await this.applyMarkdownModification(targetFile, result.raw, result.start, result.end, "remove"))) return;
        new Notice("Highlighting removed.");
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async removeAllHighlights(view: MarkdownView) {
        await this.removeAllHighlightsInFile(view.file);
    }

    async removeAllHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeAllHighlightsFromRaw(raw);
        if (!result.removedCount) {
            new Notice("No highlights to remove.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice("All highlights removed.");
    }

    async mergeAdjacentHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = mergeAdjacentHighlightsInRaw(raw);

        if (!result.mergedCount) {
            new Notice("No adjacent highlights to merge.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice(`Merged ${result.mergedCount} highlight${result.mergedCount === 1 ? "" : "s"}.`);
    }

    async recolorHighlightsInFile(file: TFile, from: RecolorSource, to: HighlightColor | null) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = recolorHighlightsInRaw(raw, { from, to });

        if (!result.changedCount) {
            new Notice("No matching highlights to recolour.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice(`Recoloured ${result.changedCount} highlight${result.changedCount === 1 ? "" : "s"}.`);
    }

    async convertHtmlHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = convertHtmlHighlightsInRaw(raw);

        if (!result.changedCount) {
            new Notice("No HTML highlights in this note.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice(
            `Converted ${result.changedCount} HTML highlight${result.changedCount === 1 ? "" : "s"} to native highlights.`
        );
    }

    async applyColorHighlight(
        view: MarkdownView,
        color: HighlightColor,
        selectionSnapshot?: SelectionSnapshot | null,
        toggle = false
    ) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) return;
        const scrollPos = getScroll(view);
        if (request.blocks.length > 1) {
            if (!(await this.highlightSpanningBlocks(view, request, toggle ? "toggle-color" : "color", color))) {
                this.handleSelectionFailure(view, request, "applyColorHighlight", color);
                return;
            }
            this.restoreScroll(view, scrollPos);
            sel?.removeAllRanges();
            return;
        }

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );
        if (!result) {
            this.handleSelectionFailure(view, request, "applyColorHighlight", color);
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);
        if (
            !(await this.applyMarkdownModification(
                targetFile,
                result.raw,
                result.start,
                result.end,
                toggle ? "toggle-color" : "color",
                color
            ))
        )
            return;
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
        new Notice("Highlighted!");
    }

    async activateNavigatorView() {
        const existing = this.app.workspace.getLeavesOfType(HIGHLIGHT_NAVIGATOR_VIEW);
        if (existing.length) {
            void this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
        await leaf.setViewState({
            type: HIGHLIGHT_NAVIGATOR_VIEW,
            active: true,
        });
        void this.app.workspace.revealLeaf(leaf);
    }

    async writeClipboardText(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            console.error("Failed to write to clipboard", e);
            return false;
        }
    }

    splitMarkdownLine(line: string) {
        const indentMatch = line.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : "";
        let remainder = line.substring(indent.length);
        let prefix = "";
        const prefixPatterns = [
            /^>\s*/,
            /^#{1,6}\s+/,
            /^-\s\[[ xX]\]\s+/,
            /^[-*+]\s+/,
            /^\d{1,3}[.)]\s+/,
            /^\[\^[^\]]+\]:\s*/,
            /^\[![^\]]+\]\s*/,
        ];
        let matched = true;
        while (matched && remainder) {
            matched = false;
            for (const pattern of prefixPatterns) {
                const match = remainder.match(pattern);
                if (match) {
                    prefix += match[0];
                    remainder = remainder.substring(match[0].length);
                    matched = true;
                    break;
                }
            }
        }
        return { indent, prefix, content: remainder };
    }

    getLineStart(raw: string, offset: number) {
        const lineBreak = raw.lastIndexOf("\n", Math.max(0, offset - 1));
        return lineBreak === -1 ? 0 : lineBreak + 1;
    }

    getLineEnd(raw: string, offset: number) {
        const lineBreak = raw.indexOf("\n", offset);
        return lineBreak === -1 ? raw.length : lineBreak;
    }

    async applyMarkdownModification(file: TFile, raw: string, start: number, end: number, mode: string, payload = "") {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        const touched = parseHighlights(raw).highlights.find((h) => h.innerStart < end && h.innerEnd > start);
        const color =
            (mode === "color" || mode === "toggle-color") && isHighlightColor(payload)
                ? payload
                : touched
                  ? touched.color
                  : this.settings.defaultHighlightColor || null;
        let newContent: string;
        try {
            newContent = editHighlightRange(raw, start, end, mode, color);
        } catch (error) {
            new Notice(error instanceof Error ? error.message : "The selection cannot be highlighted safely.");
            return false;
        }
        const finalContent = await this.app.vault.process(file, (current) => (current === raw ? newContent : current));
        if (finalContent !== newContent) {
            new Notice("The note changed while highlighting. Select the text again; those edits were preserved.");
            return false;
        }
        await this.recordUndoResult(file, finalContent);
        return true;
    }

    restoreScroll(view: MarkdownView, pos: ScrollPosition) {
        window.requestAnimationFrame(() => {
            applyScroll(view, pos);
        });
    }

    handleSelectionFailure(
        view: MarkdownView,
        request: SelectionRequest,
        actionType: string,
        payload: string | null = null
    ) {
        if (request.withinBlock?.blockText !== undefined || request.range) {
            new Notice("The selection could not be matched exactly. Select the text again; the note was not changed.");
            return;
        }
        const report = this.logic.lastFailureReport;
        if (!report) {
            new Notice("Selection failed, but no diagnostic report was generated.");
            return;
        }
        new FailureRecoveryModal(this.app, report, async (correctedText: string, learnedRule: DerivedRule | null) => {
            if (learnedRule && learnedRule.stripPattern) {
                const existing = this.settings.learnedNormRules.find(
                    (r) => r.stripPattern === learnedRule.stripPattern
                );
                if (!existing) {
                    this.settings.learnedNormRules.push({ stripPattern: learnedRule.stripPattern });
                    await this.saveSettings();
                    new Notice("Normalization rule learned for future selections!");
                }
            }
            const mockSnapshot = { text: correctedText, range: null };
            if (actionType === "applyColorHighlight" && isHighlightColor(payload)) {
                await this.applyColorHighlight(view, payload, mockSnapshot);
            } else if (actionType === "highlightSelection") {
                await this.highlightSelection(view, mockSnapshot);
            } else if (actionType === "removeHighlightSelection") {
                await this.removeHighlightSelection(view, mockSnapshot);
            }
        }).open();
    }
}

const HIGHLIGHT_COLOUR_DESC =
    "Colour the highlight button writes, as an Obsidian highlight colour (==🟡text==). Extending a highlight keeps its colour.";
const PALETTE_DESC =
    "Show Obsidian's six highlight colours in the toolbar. Highlight colours need Obsidian 1.14 or later; older versions show the colour emoji.";

class ReadingHighlighterSettingTab extends PluginSettingTab {
    plugin: ReadingHighlighterPlugin;
    constructor(app: App, plugin: ReadingHighlighterPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        const s = this.plugin.settings;
        const colourOptions: Record<string, string> = { "": "Theme default" };
        for (const color of HIGHLIGHT_COLORS) colourOptions[color] = COLOR_LABELS[color];

        return [
            {
                type: "group",
                heading: "Highlighting",
                items: [
                    {
                        name: "Toolbar position",
                        desc: "Choose where the floating toolbar should appear.",
                        control: {
                            type: "dropdown",
                            key: "toolbarPosition",
                            options: {
                                text: "Above the Text (default)",
                                top: "Fixed at top center",
                                bottom: "Fixed at bottom center",
                                left: "Fixed left side",
                                right: "Fixed right side",
                            },
                        },
                    },
                    {
                        name: "Enable smart paragraph selection",
                        desc: "Snap selections inside a paragraph, list item, heading, or blockquote to the entire block.",
                        control: { type: "toggle", key: "enableSmartParagraphSelection" },
                    },
                    {
                        name: "Highlight colour",
                        desc: HIGHLIGHT_COLOUR_DESC,
                        control: { type: "dropdown", key: "defaultHighlightColor", options: colourOptions },
                    },
                    {
                        name: "Show colour palette",
                        desc: PALETTE_DESC,
                        control: { type: "toggle", key: "enableColorPalette" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Toolbar buttons",
                items: [{ name: "Show remove button", control: { type: "toggle", key: "showRemoveButton" } }],
            },
            {
                type: "group",
                heading: "Mobile and UX",
                items: [
                    {
                        name: "Haptic feedback",
                        desc: "Vibrate slightly on success (mobile only).",
                        control: { type: "toggle", key: "enableHaptics" },
                    },
                    {
                        name: "Show button tooltips",
                        desc: "Show tooltips when hovering over toolbar buttons.",
                        control: { type: "toggle", key: "showTooltips" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Learned normalization rules",
                items: s.learnedNormRules.length
                    ? [
                          ...s.learnedNormRules.map((rule, index) => ({
                              name: `Rule ${index + 1}`,
                              desc: `Ignore: "${rule.stripPattern}"`,
                              action: (el: HTMLElement) => {
                                  new Setting(el).addButton((btn) => {
                                      btn.setButtonText("Delete").onClick(async () => {
                                          this.plugin.settings.learnedNormRules.splice(index, 1);
                                          await this.plugin.saveSettings();
                                          new Notice("Rule deleted.");
                                          this.refreshDefinitions();
                                      });
                                      btn.buttonEl.addClass("mod-warning");
                                  });
                              },
                          })),
                          {
                              name: "Clear all rules",
                              action: (el: HTMLElement) => {
                                  new Setting(el).addButton((btn) => {
                                      btn.setButtonText("Clear all rules").onClick(async () => {
                                          this.plugin.settings.learnedNormRules = [];
                                          await this.plugin.saveSettings();
                                          new Notice("All rules cleared.");
                                          this.refreshDefinitions();
                                      });
                                      btn.buttonEl.addClass("mod-warning");
                                  });
                              },
                          },
                      ]
                    : [{ name: "No rules learned yet." }],
            },
        ];
    }

    /** Read a declarative control's value out of the plugin's settings. */
    getControlValue(key: string): unknown {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    /** Persist a declarative control's value, mirroring the imperative handlers. */
    setControlValue(key: string, value: unknown): void {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        // Text-bearing controls hand back a string; anything else is stored as
        // given, so a toggle stays a boolean.
        const asText = typeof value === "string" ? value : "";
        if (key === "defaultHighlightColor") {
            settings[key] = isHighlightColor(asText) ? asText : "";
        } else {
            settings[key] = value;
        }
        void this.plugin.saveSettings();
        // Several settings gate whether others are shown at all, so re-evaluate
        // the definitions rather than leaving a stale panel behind.
        this.refreshDefinitions();
    }

    refreshDefinitions() {
        this.update();
    }
}
