import {
    App,
    Plugin,
    Notice,
    Platform,
    PluginSettingTab,
    Setting,
    MarkdownView,
    View,
    TFile,
    WorkspaceLeaf,
    loadPdfJs,
    normalizePath,
    type SettingDefinitionItem,
    type SettingGroupItem,
} from "obsidian";
import { FloatingManager, type SelectionSnapshot } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { AnnotationModal } from "./modals/AnnotationModal";
import { HighlightNavigatorView, HIGHLIGHT_NAVIGATOR_VIEW } from "./views/HighlightNavigator";
import { ResearchView, RESEARCH_VIEW } from "./views/ResearchView";
import { getScroll, applyScroll, type ScrollPosition } from "./utils/dom";
import { exportHighlightsToCSV, exportHighlightsToJSON, exportHighlightsToMD } from "./utils/export";
import { FailureRecoveryModal, type DerivedRule } from "./ui/FailureRecoveryModal";
import {
    parseHighlights,
    mergeAdjacentHighlightsInRaw,
    convertHtmlHighlightsInRaw,
    recolorHighlightsInRaw,
    removeAllHighlightsFromRaw,
    removeFootnoteFromRaw,
    removeAllFootnotesFromRaw,
    type RecolorSource,
} from "./utils/highlights";
import {
    COLOR_LABELS,
    HIGHLIGHT_COLORS,
    isHighlightColor,
    nearestHighlightColor,
    wrapHighlight,
    type HighlightColor,
} from "./utils/colors";
import { getSelectedOccurrence, readBlockTextAndCaret, type SelectionHint } from "./utils/blockOccurrence";
import { kindForElement, type BlockKind } from "./utils/sourceBlocks";
import { editHighlightRange } from "./utils/preciseHighlight";
import { BulkRecolorModal } from "./modals/BulkRecolorModal";

export interface SemanticColor {
    color: HighlightColor;
    meaning: string;
}

interface LearnedNormRule {
    stripPattern: string;
}

/** Settings written by versions that coloured highlights with HTML. */
interface LegacyColorSettings {
    enableColorHighlighting?: boolean;
    highlightColor?: string;
    semanticColors?: { color?: string; meaning?: string }[];
}

interface ReadingHighlighterSettings {
    toolbarPosition: string;
    /** Colour the plain highlight button writes; empty for the theme's default. */
    defaultHighlightColor: HighlightColor | "";
    defaultTagPrefix: string;
    enableHaptics: boolean;
    showTagButton: boolean;
    showRemoveButton: boolean;
    showQuoteButton: boolean;
    enableColorPalette: boolean;
    showOnlyAssignedColors: boolean;
    semanticColors: SemanticColor[];
    quoteTemplate: string;
    enableAnnotations: boolean;
    showAnnotationButton: boolean;
    enableReadingProgress: boolean;
    readingPositions: Record<string, number>;
    enableSmartTagSuggestions: boolean;
    recentTags: string[];
    maxRecentTags: number;
    showNavigatorButton: boolean;
    showTooltips: boolean;
    enableFrontmatterTag: boolean;
    frontmatterTag: string;
    enableSmartParagraphSelection: boolean;
    learnedNormRules: LearnedNormRule[];
    researchAutoScan: boolean;
    researchFolders: string;
    researchExcludedFolders: string;
}

const SMART_SELECTION_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"]);

const FRONTMATTER_NEEDS_QUOTES_RE = new RegExp("[:\\s{}\\[\\],&*#?|<>=!%@\\\\-]");
const FRONTMATTER_RESERVED_RE = /^(true|false|null|yes|no|on|off)$/i;

const DEFAULT_SETTINGS: ReadingHighlighterSettings = {
    toolbarPosition: "right",
    defaultHighlightColor: "",
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true,
    enableColorPalette: false,
    showOnlyAssignedColors: true,
    semanticColors: HIGHLIGHT_COLORS.map((color) => ({ color, meaning: "" })),
    quoteTemplate: "> {{text}}\n>\n> — [[{{file}}]]",
    enableAnnotations: true,
    showAnnotationButton: true,
    enableReadingProgress: true,
    readingPositions: {},
    enableSmartTagSuggestions: true,
    recentTags: [],
    maxRecentTags: 10,
    showNavigatorButton: true,
    showTooltips: false,
    enableFrontmatterTag: false,
    frontmatterTag: "resaltados",
    enableSmartParagraphSelection: false,
    learnedNormRules: [],
    researchAutoScan: false,
    researchFolders: "",
    researchExcludedFolders: "",
};

/**
 * The palette, one entry per native colour in Obsidian's order.
 *
 * Older versions kept fifteen hex colours. Each meaning the reader gave one of
 * those moves to the native colour nearest it, so a taxonomy survives the
 * switch; two meanings landing on one colour are joined rather than lost.
 */
function migratePalette(saved: LegacyColorSettings["semanticColors"]): SemanticColor[] {
    const palette: SemanticColor[] = HIGHLIGHT_COLORS.map((color) => ({ color, meaning: "" }));
    for (const entry of saved ?? []) {
        const meaning = (entry?.meaning ?? "").trim();
        const color = isHighlightColor(entry?.color) ? entry.color : nearestHighlightColor(entry?.color);
        if (!meaning || !color) continue;
        const target = palette[HIGHLIGHT_COLORS.indexOf(color)];
        const existing = target.meaning.split(" / ").filter(Boolean);
        if (!existing.includes(meaning)) target.meaning = [...existing, meaning].join(" / ");
    }
    return palette;
}

// Stringify an unknown frontmatter value the same way `String(value || "")`
// did, but in a form the type-checker is happy with.
function toDisplayString(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value) return "";
    const primitive: string | number | boolean = value as string | number | boolean;
    return String(primitive);
}

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

interface PdfTextItem {
    str: string;
    transform: number[];
}

interface PdfPage {
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
}

interface PdfJs {
    getDocument(args: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
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
    lastScrollPosition: ScrollPosition | null = null;
    /** A reading position waiting to be saved once scrolling settles. */
    pendingProgress: { view: MarkdownView; file: TFile } | null = null;
    progressTimer: number | null = null;

    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app, () => this.settings.learnedNormRules);

        this.registerView(HIGHLIGHT_NAVIGATOR_VIEW, (leaf) => new HighlightNavigatorView(leaf, this));

        this.registerView(RESEARCH_VIEW, (leaf) => new ResearchView(leaf, this));

        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));
        this.registerCommands();

        this.registerWindowEvents(activeDocument);
        // A popout window has a document of its own, which fires its own
        // selection and scroll events.
        this.registerEvent(this.app.workspace.on("window-open", (win) => this.registerWindowEvents(win.doc)));

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                // The position waiting to be saved belongs to the note being left.
                this.flushReadingProgress();
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

        this.addRibbonIcon("lamp", "Highlight navigator", () => {
            void this.activateNavigatorView();
        });

        this.floatingManager.load();
    }

    registerCommands() {
        this.addCommand({
            id: "highlight-selection-reading",
            name: "Toggle highlight selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.highlightSelection(view, null, true);
                return true;
            },
        });

        this.addCommand({
            id: "tag-selection",
            name: "Tag selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.tagSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "extract-all-pdf-text",
            name: "Extract all text from current PDF",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(View);
                if (view && view.getViewType() === "pdf") {
                    if (!checking) {
                        void this.extractAllPdfText(view);
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: "annotate-selection",
            name: "Add annotation to selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.annotateSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "copy-as-quote",
            name: "Copy selection as quote (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.copyAsQuote(view);
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
            id: "open-research-view",
            name: "Open global research view",
            callback: () => {
                void this.activateResearchView();
            },
        });

        this.addCommand({
            id: "export-highlights",
            name: "Export highlights to new note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.exportHighlights(view);
                return true;
            },
        });

        this.addCommand({
            id: "export-highlights-json",
            name: "Export highlights to JSON",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.exportHighlightsJSON(view);
                return true;
            },
        });

        this.addCommand({
            id: "export-highlights-csv",
            name: "Export highlights to CSV",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.exportHighlightsCSV(view);
                return true;
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
            id: "remove-all-annotations",
            name: "Remove all annotations from note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.removeAllAnnotations(view.file);
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

        this.addCommand({
            id: "resume-reading",
            name: "Resume reading (jump to last position)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.resumeReading(view);
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
                    const view = this.getActiveReadingView();
                    if (!view) return false;
                    if (checking) return true;
                    void this.applyColorByIndex(view, i, null, true);
                    return true;
                },
            });
        });
    }

    async activateResearchView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(RESEARCH_VIEW);
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getLeaf("tab");
            await leaf.setViewState({ type: RESEARCH_VIEW, active: true });
        }
        void workspace.revealLeaf(leaf);
    }

    onunload() {
        this.flushReadingProgress();
        this.floatingManager.unload();
    }

    registerWindowEvents(doc: Document) {
        this.registerDomEvent(doc, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });
        // Scroll does not bubble, so listen in the capture phase.
        this.registerDomEvent(doc, "scroll", (evt) => this.onReadingScroll(evt), { capture: true, passive: true });
    }

    async loadSettings() {
        const loaded = ((await this.loadData()) as Partial<ReadingHighlighterSettings> & LegacyColorSettings) || {};
        const { enableColorHighlighting, highlightColor, ...current } = loaded;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, current, {
            semanticColors: migratePalette(loaded.semanticColors),
        });
        if (!isHighlightColor(this.settings.defaultHighlightColor)) {
            // A default colour chosen when highlights were HTML becomes the
            // nearest native one.
            this.settings.defaultHighlightColor =
                (enableColorHighlighting && nearestHighlightColor(highlightColor)) || "";
        }
    }

    async saveSettings() {
        for (const leaf of this.app.workspace.getLeavesOfType(RESEARCH_VIEW)) {
            (leaf.view as ResearchView).refreshScanScope();
        }
        await this.saveData(this.settings);
        this.floatingManager.refresh();
    }

    getActiveReadingView(): MarkdownView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view && view.getMode() === "preview" ? view : null;
    }

    getSelectionContext(selectionSnapshot: SelectionSnapshot | null) {
        const view = this.getActiveReadingView();
        const range = this.getSelectionRange(selectionSnapshot);
        if (!view || !range) return null;

        const blocks = this.getAllowedBlocksInRange(range, view.contentEl);
        const fallbackBlock = this.getClosestAllowedBlock(range.commonAncestorContainer, view.contentEl);
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
        const contextText = this.getElementText(contextElement);
        const matching = [...view.contentEl.querySelectorAll<HTMLElement>(contextElement.tagName.toLowerCase())].filter(
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
        // Without a recorded result the change was never written (a tag or
        // annotation dialog that was cancelled), so there is nothing to undo.
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
        if (index < 0 || index >= this.settings.semanticColors.length) return;
        const palette = this.settings.semanticColors[index];
        await this.applyColorHighlight(view, palette.color, "", selectionSnapshot, toggle);
    }

    async savePdfHighlight(
        view: View & { file?: TFile },
        selectionSnapshot: SelectionSnapshot | null,
        mode: string,
        payload: string | number
    ) {
        if (!view.file) return;
        let snippet = selectionSnapshot?.text || window.getSelection()?.toString() || "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }
        snippet = this.sanitizePdfText(snippet);
        const pdfName = view.file.basename;
        // normalizePath, because a PDF at the vault root has the parent path
        // "/" and the joined path would start with "//".
        const companionFile = normalizePath(`${view.file.parent?.path ?? ""}/${pdfName} - Highlights.md`);
        const fileExists = this.app.vault.getAbstractFileByPath(companionFile);

        let highlightOutput = snippet.trim();
        if (mode === "color") {
            const index = typeof payload === "number" ? payload : parseInt(payload);
            const palette = this.settings.semanticColors[index];
            if (palette) {
                // One highlight per line: a pair cannot span the quote's lines.
                highlightOutput = highlightOutput
                    .split("\n")
                    .map((line) => wrapHighlight(line, palette.color))
                    .join("\n");
            }
        } else if (mode === "action") {
            if (payload === "highlightSelection") {
                highlightOutput = snippet.trim();
            } else if (payload === "copyAsQuote") {
                void this.copyAsQuote(view as unknown as MarkdownView, { ...selectionSnapshot, text: snippet });
                return;
            } else {
                return;
            }
        }

        const blockId = "^" + Math.random().toString(36).substring(2, 8);
        const blockquotedText = highlightOutput
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        const appendString = `${blockquotedText}\n> — [[${view.file.path}|${pdfName}]] ${blockId}\n\n`;

        try {
            if (fileExists instanceof TFile) {
                const fileContent = await this.app.vault.read(fileExists);
                await this.app.vault.modify(fileExists, fileContent + "\n" + appendString);
            } else {
                const fileContent = `# Highlights from [[${view.file.path}|${pdfName}]]\n\n${appendString}`;
                await this.app.vault.create(companionFile, fileContent);
            }
            new Notice("Saved to " + pdfName + " - Highlights");
            window.getSelection()?.removeAllRanges();
            if (this.settings.enableHaptics && Platform.isMobile) {
                navigator.vibrate?.(10);
            }
        } catch (e) {
            console.error("Failed to save PDF highlight", e);
            new Notice("Failed to save PDF highlight");
        }
    }

    sanitizePdfText(text: string) {
        if (!text) return text;
        let sanitized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
        sanitized = sanitized.replace(/(\w)-\n(\w)/g, "$1$2");
        sanitized = sanitized.replace(/\n\n+/g, "[[PAR_BREAK]]");
        sanitized = sanitized.replace(/\n(?=[ \t]*[-*+] |[ \t]*\d+[.)] )/g, "[[LIST_BREAK]]");
        // A newline that does not follow sentence-ending punctuation is a soft
        // wrap, so it becomes a space. Written with a replacer rather than a
        // lookbehind: lookbehind is a parse error on iOS before 16.4, which
        // would stop the whole plugin from loading there.
        sanitized = sanitized.replace(/\n/g, (match, offset: number, full: string) =>
            offset > 0 && ".!?/:;".includes(full[offset - 1]) ? match : " "
        );
        sanitized = sanitized.replace(/\[\[PAR_BREAK\]\]/g, "\n\n");
        sanitized = sanitized.replace(/\[\[LIST_BREAK\]\]/g, "\n");
        return sanitized.replace(/[ \t]+/g, " ").trim();
    }

    async extractAllPdfText(view: View & { file?: TFile }) {
        if (!view || view.getViewType() !== "pdf" || !view.file) {
            new Notice("Please open a PDF file first.");
            return;
        }

        const notice = new Notice("Extracting all PDF text...", 0);

        try {
            const pdfjs = (await loadPdfJs()) as PdfJs;
            const buffer = await this.app.vault.readBinary(view.file);
            const loadingTask = pdfjs.getDocument({ data: buffer });
            const pdf = await loadingTask.promise;

            let fullText = "";
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                let lastY = -1;
                let pageText = "";
                for (const item of content.items) {
                    if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                        pageText += "\n";
                    } else if (lastY !== -1) {
                        pageText += " ";
                    }
                    pageText += item.str;
                    lastY = item.transform[5];
                }
                fullText += pageText + "\n\n";
                if (i % 10 === 0) notice.setMessage(`Extracting text... Page ${i}/${pdf.numPages}`);
            }

            const dummySnapshot = { text: fullText, range: null };
            await this.savePdfHighlight(view, dummySnapshot, "action", "highlightSelection");
            notice.hide();
            new Notice(`Successfully extracted ${pdf.numPages} pages.`);
        } catch (e) {
            console.error("Full PDF extraction failed", e);
            notice.hide();
            new Notice("Failed to extract PDF text.");
        }
    }

    async tagSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const scrollPos = getScroll(view);

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
            this.handleSelectionFailure(view, request, "tagSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        new TagSuggestModal(this, async (tag) => {
            const newResult = await this.logic.locateSelection(
                view.file,
                view,
                request.snippet,
                request.contextText,
                request.occurrenceIndex,
                request.withinBlock,
                request.contextKind
            );
            if (!newResult) {
                new Notice("Selection lost - file may have changed.");
                return;
            }

            if (tag && this.settings.enableSmartTagSuggestions) {
                this.addRecentTag(tag);
            }

            if (
                !(await this.applyMarkdownModification(
                    targetFile,
                    newResult.raw,
                    newResult.start,
                    newResult.end,
                    "tag",
                    tag
                ))
            )
                return;
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
        }).open();
    }

    addRecentTag(tag: string) {
        const cleanTag = tag.replace(/^#/, "").trim();
        if (!cleanTag) return;
        this.settings.recentTags = this.settings.recentTags.filter((t) => t !== cleanTag);
        this.settings.recentTags.unshift(cleanTag);
        if (this.settings.recentTags.length > this.settings.maxRecentTags) {
            this.settings.recentTags = this.settings.recentTags.slice(0, this.settings.maxRecentTags);
        }
        void this.saveData(this.settings);
    }

    async annotateSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const scrollPos = getScroll(view);

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
            this.handleSelectionFailure(view, request, "annotateSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        new AnnotationModal(this.app, async (comment) => {
            const newResult = await this.logic.locateSelection(
                view.file,
                view,
                request.snippet,
                request.contextText,
                request.occurrenceIndex,
                request.withinBlock,
                request.contextKind
            );
            if (!newResult) {
                new Notice("Selection lost - file may have changed.");
                return;
            }

            const currentRaw = await this.app.vault.read(targetFile);
            await this.applyAnnotation(targetFile, currentRaw, newResult.start, newResult.end, comment);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
            new Notice("Annotation added!");
        }).open();
    }

    async applyAnnotation(file: TFile, raw: string, start: number, end: number, comment: string) {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        const footnotePattern = /\[\^(\d+)\]/g;
        let maxNumber = 0;
        let match: RegExpExecArray | null;
        while ((match = footnotePattern.exec(raw)) !== null) {
            const num = parseInt(match[1]);
            if (num > maxNumber) maxNumber = num;
        }
        const footnoteNum = maxNumber + 1;
        const beforeSelection = raw.substring(0, end);
        const afterSelection = raw.substring(end);
        const footnoteRef = `[^${footnoteNum}]`;
        const footnoteDef = `\n\n[^${footnoteNum}]: ${comment}`;
        let newContent = beforeSelection + footnoteRef + afterSelection;
        newContent = newContent.trimEnd() + footnoteDef + "\n";
        await this.app.vault.modify(file, newContent);
        await this.recordUndoResult(file, newContent);
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

    async removeAnnotationById(file: TFile, footnoteId: string) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeFootnoteFromRaw(raw, footnoteId);
        if (!result.changed) {
            new Notice("Annotation not found.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice("Annotation removed.");
    }

    async removeAllAnnotations(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeAllFootnotesFromRaw(raw);
        if (!result.removedCount) {
            new Notice("No annotations to remove.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        new Notice(`Removed ${result.removedCount} annotation${result.removedCount === 1 ? "" : "s"}.`);
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

    async exportHighlights(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToMD(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights.");
            console.error(err);
        }
    }

    async exportHighlightsJSON(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToJSON(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights to JSON.");
            console.error(err);
        }
    }

    async exportHighlightsCSV(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToCSV(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights to CSV.");
            console.error(err);
        }
    }

    async copyAsQuote(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const frontmatter =
            (this.app.metadataCache.getFileCache(view.file)?.frontmatter as Record<string, unknown>) || {};
        const quote = this.expandQuoteTemplate(view.file, request.snippet, frontmatter);
        const copied = await this.writeClipboardText(quote);
        if (!copied) {
            new Notice("Failed to copy quote.");
            return;
        }
        new Notice("Copied as quote!");
        sel?.removeAllRanges();
    }

    async applyColorHighlight(
        view: MarkdownView,
        color: HighlightColor,
        autoTag = "",
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
                color,
                autoTag
            ))
        )
            return;
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
        new Notice("Highlighted!");
    }

    /**
     * Note where the active reading view has scrolled to, once it stops.
     *
     * Saving on `active-leaf-change` alone read the note being *opened*, not
     * the one being left, and missed navigation within a tab altogether.
     */
    onReadingScroll(evt: Event) {
        if (!this.settings.enableReadingProgress) return;
        const view = this.getActiveReadingView();
        const target = evt.target as Node | null;
        if (!view?.file || !target || !view.containerEl.contains(target)) return;
        this.pendingProgress = { view, file: view.file };
        if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
        this.progressTimer = window.setTimeout(() => this.flushReadingProgress(), 800);
    }

    flushReadingProgress() {
        if (this.progressTimer !== null) {
            window.clearTimeout(this.progressTimer);
            this.progressTimer = null;
        }
        const pending = this.pendingProgress;
        this.pendingProgress = null;
        // A tab that has moved on to another note scrolls for that note now.
        if (!pending || pending.view.file !== pending.file || !this.settings.enableReadingProgress) return;
        let y = 0;
        try {
            y = getScroll(pending.view).y;
        } catch {
            return;
        }
        const path = pending.file.path;
        if (y > 0) this.settings.readingPositions[path] = y;
        else if (path in this.settings.readingPositions) delete this.settings.readingPositions[path];
        else return;
        void this.saveData(this.settings);
    }

    async resumeReading(view: MarkdownView) {
        const pos = this.settings.readingPositions[view.file.path];
        if (pos) {
            applyScroll(view, { x: 0, y: pos });
            new Notice("Resumed reading position.");
        } else {
            new Notice("No saved position for this file.");
        }
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

    /**
     * Fill the quote template.
     *
     * Whatever precedes `{{text}}` on its line (`> ` in the default) starts
     * every line of the selection, so a quote of several lines stays one
     * blockquote. The selection used to arrive already quoted, which with the
     * default template nested its first line one level deeper (`> > `). A
     * template with no `>` before `{{text}}` still gets each line quoted.
     */
    expandQuoteTemplate(file: TFile, text: string, frontmatter: Record<string, unknown> = {}) {
        const sourceUrl = toDisplayString(frontmatter.url || frontmatter.source || frontmatter.link).replace(
            /#:~:text=[^&]+(&|$)/,
            ""
        );
        const timestamp = this.formatTimestamp(new Date());
        const variables: Record<string, string> = {
            file: file.basename,
            path: file.path,
            date: timestamp.split("T")[0],
            time: timestamp,
            domain: this.extractDomain(sourceUrl),
            author: this.normalizeFrontmatterValue(
                frontmatter.author || frontmatter.authors || frontmatter.creator || ""
            ),
        };
        const lines = text.split(/\r?\n/);
        return this.settings.quoteTemplate
            .replace(/{{(file|path|date|time|domain|author)}}/g, (_match: string, key: string) => variables[key] || "")
            .replace(/^(.*?){{text}}/gm, (_match: string, prefix: string) => {
                if (/>\s*$/.test(prefix)) return prefix + lines.join(`\n${prefix}`);
                return prefix + lines.map((line) => `> ${line}`).join("\n");
            });
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

    formatTimestamp(date: Date) {
        const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? "+" : "-";
        const offsetHours = pad(offsetMinutes / 60);
        const offsetRemainder = pad(offsetMinutes % 60);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetHours}:${offsetRemainder}`;
    }

    extractDomain(url: string) {
        if (!url) return "";
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname;
            if (hostname === "localhost" || hostname === "127.0.0.1" || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
                return hostname;
            }
            const hostParts = hostname.split(".");
            if (hostParts.length > 2) {
                const lastTwo = hostParts.slice(-2).join(".");
                if (/^(co|com|org|net|edu|gov|mil)\.[a-z]{2}$/i.test(lastTwo)) {
                    return hostParts.slice(-3).join(".");
                }
            }
            return hostParts.slice(-2).join(".");
        } catch {
            return "";
        }
    }

    normalizeFrontmatterValue(value: unknown) {
        if (Array.isArray(value)) {
            return (value as unknown[])
                .map((item) => String(item as string).trim())
                .filter(Boolean)
                .join(", ");
        }
        return toDisplayString(value).trim();
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

    needsYamlQuotes(value: string) {
        const trimmedValue = String(value || "").trim();
        return (
            FRONTMATTER_NEEDS_QUOTES_RE.test(trimmedValue) ||
            /^\d/.test(trimmedValue) ||
            FRONTMATTER_RESERVED_RE.test(trimmedValue)
        );
    }

    normalizeTagForComparison(tag: string) {
        return String(tag || "")
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .replace(/^#/, "")
            .replace(/\s+/g, "_");
    }

    formatFrontmatterTag(tag: string) {
        const normalized = this.normalizeTagForComparison(tag);
        if (!normalized) {
            return "";
        }
        return this.needsYamlQuotes(normalized) ? `"${normalized.replace(/"/g, '\\"')}"` : normalized;
    }

    async applyMarkdownModification(
        file: TFile,
        raw: string,
        start: number,
        end: number,
        mode: string,
        payload = "",
        autoTag = ""
    ) {
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
        let fullTag = "";
        const sanitizeTag = (t: string) => t.trim().replace(/^#/, "").replace(/\s+/g, "_");
        if (mode === "tag" && payload) {
            const prefix = this.settings.defaultTagPrefix ? sanitizeTag(this.settings.defaultTagPrefix) : "";
            const cleanPayload = payload
                .split(/\s+/)
                .map(sanitizeTag)
                .filter((t) => t)
                .map((t) => `#${t}`)
                .join(" ");
            if (prefix) {
                fullTag = `#${sanitizeTag(prefix)} ${cleanPayload}`;
            } else {
                fullTag = cleanPayload;
            }
        } else if (
            (mode === "highlight" || mode === "color" || mode.startsWith("toggle-")) &&
            this.settings.defaultTagPrefix
        ) {
            const autoTagSetting = sanitizeTag(this.settings.defaultTagPrefix);
            if (autoTagSetting) {
                fullTag = `#${autoTagSetting}`;
            }
        }
        if (autoTag) {
            const cleanAutoTag = sanitizeTag(autoTag);
            fullTag = fullTag ? `${fullTag} #${cleanAutoTag}` : `#${cleanAutoTag}`;
        }
        let newContent: string;
        try {
            newContent = editHighlightRange(raw, start, end, mode, color, fullTag);
        } catch (error) {
            new Notice(error instanceof Error ? error.message : "The selection cannot be highlighted safely.");
            return false;
        }
        const finalContent = await this.app.vault.process(file, (current) => (current === raw ? newContent : current));
        if (finalContent !== newContent) {
            new Notice("The note changed while highlighting. Select the text again; those edits were preserved.");
            return false;
        }
        const removed =
            mode === "remove" ||
            (mode.startsWith("toggle-") &&
                parseHighlights(newContent).highlights.length < parseHighlights(raw).highlights.length);
        if (!removed && this.settings.enableFrontmatterTag && this.settings.frontmatterTag) {
            const targetTag = this.formatFrontmatterTag(this.settings.frontmatterTag);
            if (targetTag) {
                try {
                    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
                        if (frontmatter.tags === undefined || frontmatter.tags === null) {
                            frontmatter.tags = [targetTag];
                            return;
                        }
                        if (Array.isArray(frontmatter.tags)) {
                            const existingTags = (frontmatter.tags as unknown[]).map((tag) =>
                                this.normalizeTagForComparison(String(tag as string))
                            );
                            if (!existingTags.includes(this.normalizeTagForComparison(targetTag))) {
                                (frontmatter.tags as unknown[]).push(targetTag);
                            }
                        } else if (typeof frontmatter.tags === "string") {
                            const existingTags = frontmatter.tags.includes(",")
                                ? frontmatter.tags.split(",").map((t) => t.trim())
                                : frontmatter.tags.split(/\s+/).map((t) => t.trim());
                            const cleanTags = existingTags.filter(
                                (tag) =>
                                    this.normalizeTagForComparison(tag) !== this.normalizeTagForComparison(targetTag) &&
                                    tag !== ""
                            );
                            if (cleanTags.length === existingTags.length) {
                                frontmatter.tags = [...cleanTags, targetTag];
                            }
                        }
                    });
                } catch (e) {
                    console.error("Superier Highlighter: Failed to inject frontmatter tag.", e);
                }
            }
        }
        // Read back rather than reuse newContent: the frontmatter step above
        // may have written to the note again.
        await this.recordUndoResult(file);
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
                await this.applyColorHighlight(view, payload, "", mockSnapshot);
            } else if (actionType === "highlightSelection") {
                await this.highlightSelection(view, mockSnapshot);
            } else if (actionType === "tagSelection") {
                await this.tagSelection(view, mockSnapshot);
            } else if (actionType === "annotateSelection") {
                await this.annotateSelection(view, mockSnapshot);
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
        const colourMeanings: SettingGroupItem[] = s.semanticColors.map((item, index) => ({
            name: COLOR_LABELS[item.color],
            aliases: item.meaning ? [item.meaning] : [],
            control: { type: "text", key: `semanticColors.${index}.meaning`, placeholder: "Meaning (e.g. Disagree)" },
        }));
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
                                text: "Next to text",
                                top: "Fixed at top center",
                                bottom: "Fixed at bottom center",
                                left: "Fixed left side",
                                right: "Fixed right side (default)",
                            },
                        },
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
                    {
                        name: "Only show colours with a meaning",
                        desc: "Hide palette colours that have no meaning assigned below, so the toolbar shows only the ones you actually use. Turn this off to show all of them.",
                        visible: () => this.plugin.settings.enableColorPalette,
                        control: { type: "toggle", key: "showOnlyAssignedColors" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Semantic colour meanings",
                visible: () => this.plugin.settings.enableColorPalette,
                items: colourMeanings,
            },
            {
                type: "group",
                heading: "Tags",
                items: [
                    {
                        name: "Default tag prefix",
                        desc: "Automatically add this tag to every highlight (e.g., 'book').",
                        control: { type: "text", key: "defaultTagPrefix", placeholder: "Book" },
                    },
                    {
                        name: "Smart tag suggestions",
                        desc: "Suggest tags based on recent usage, folder, and frontmatter.",
                        control: { type: "toggle", key: "enableSmartTagSuggestions" },
                    },
                    {
                        name: "Enable smart paragraph selection",
                        desc: "Snap selections inside a paragraph, list item, heading, or blockquote to the entire block.",
                        control: { type: "toggle", key: "enableSmartParagraphSelection" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Quote template",
                items: [
                    {
                        name: "Quote format",
                        desc: "Template for copying text as quote. Variables: {{text}}, {{file}}, {{path}}, {{date}}, {{time}}, {{domain}}, {{author}}",
                        control: { type: "textarea", key: "quoteTemplate" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Annotations",
                items: [
                    {
                        name: "Enable annotations",
                        desc: "Add comments to selections as footnotes.",
                        control: { type: "toggle", key: "enableAnnotations" },
                    },
                    {
                        name: "Show annotation button",
                        desc: "Show the annotation button in the toolbar.",
                        control: { type: "toggle", key: "showAnnotationButton" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Reading progress",
                items: [
                    {
                        name: "Track reading progress",
                        desc: "Remember scroll position when leaving a file.",
                        control: { type: "toggle", key: "enableReadingProgress" },
                    },
                    {
                        name: "Clear reading positions",
                        desc: `Currently tracking ${Object.keys(s.readingPositions).length} file(s).`,
                        action: (el: HTMLElement) => {
                            new Setting(el).addButton((button) =>
                                button.setButtonText("Clear all").onClick(async () => {
                                    this.plugin.settings.readingPositions = {};
                                    await this.plugin.saveSettings();
                                    new Notice("Reading positions cleared.");
                                    this.refreshDefinitions();
                                })
                            );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Toolbar buttons",
                items: [
                    { name: "Show tag button", control: { type: "toggle", key: "showTagButton" } },
                    { name: "Show quote button", control: { type: "toggle", key: "showQuoteButton" } },
                    { name: "Show remove button", control: { type: "toggle", key: "showRemoveButton" } },
                ],
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
                heading: "Frontmatter integration",
                items: [
                    {
                        name: "Auto-tag highlight in frontmatter",
                        desc: "Automatically inject a specific tag into the note's frontmatter whenever you highlight text.",
                        control: { type: "toggle", key: "enableFrontmatterTag" },
                    },
                    {
                        name: "Frontmatter highlight tag",
                        desc: "The tag to add (e.g. 'resaltados'). Do not include the # symbol.",
                        visible: () => this.plugin.settings.enableFrontmatterTag,
                        control: { type: "text", key: "frontmatterTag", placeholder: "Resaltados" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Research view",
                items: [
                    {
                        name: "Scan when research view opens",
                        desc: "Read notes in the selected folders when opening or restoring research view. Off by default; use Scan folders to start manually.",
                        control: { type: "toggle", key: "researchAutoScan" },
                    },
                    {
                        name: "Include folders",
                        desc: "Vault-relative folder paths, one per line. Includes subfolders. Leave empty to search all Markdown notes. No wildcards or parent paths.",
                        control: {
                            type: "textarea",
                            key: "researchFolders",
                            placeholder: "Research\nReading notes",
                            rows: 3,
                        },
                    },
                    {
                        name: "Exclude folders",
                        desc: "Vault-relative folder paths, one per line. Exclusions take priority; notes in these folders are not read or included in research exports.",
                        control: {
                            type: "textarea",
                            key: "researchExcludedFolders",
                            placeholder: "Private\nArchive",
                            rows: 3,
                        },
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
        const colour = key.match(/^semanticColors\.(\d+)\.meaning$/);
        if (colour) return this.plugin.settings.semanticColors[Number(colour[1])]?.meaning ?? "";
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    /** Persist a declarative control's value, mirroring the imperative handlers. */
    setControlValue(key: string, value: unknown): void {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        // Text-bearing controls hand back a string; anything else is stored as
        // given, so a toggle stays a boolean.
        const asText = typeof value === "string" ? value : "";
        const colour = key.match(/^semanticColors\.(\d+)\.meaning$/);
        if (colour) {
            const entry = this.plugin.settings.semanticColors[Number(colour[1])];
            if (entry) entry.meaning = asText;
        } else if (key === "defaultTagPrefix") {
            settings[key] = asText.replace(/\s+/g, "_").replace(/^#/, "");
        } else if (key === "frontmatterTag") {
            settings[key] = asText.replace(/^#/, "");
        } else if (key === "defaultHighlightColor") {
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
