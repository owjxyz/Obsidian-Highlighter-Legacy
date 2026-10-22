import { Modal, Setting, Notice, TFile } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import {
    parseHighlights,
    findHighlightById,
    removeHighlightFromRaw,
    updateHighlightColorInRaw,
} from "../utils/highlights";
import { COLOR_LABELS, HIGHLIGHT_COLORS, isHighlightColor, type HighlightColor } from "../utils/colors";

interface EditState {
    color: HighlightColor | null;
}

export class HighlightEditModal extends Modal {
    plugin: ReadingHighlighterPlugin;
    file: TFile;
    highlightId: string;
    onApplied: (raw: string) => void;
    state: EditState;

    constructor(
        plugin: ReadingHighlighterPlugin,
        file: TFile,
        highlightId: string,
        onApplied: (raw: string) => void = () => {}
    ) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
        this.highlightId = highlightId;
        this.onApplied = onApplied;

        this.state = {
            color: null,
        };
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();

        contentEl.addClass("reading-highlighter-highlight-edit-modal");
        modalEl.addClass("reading-highlighter-highlight-edit-modal");

        contentEl.createEl("h2", { text: "Edit highlight" });

        let raw: string;
        try {
            raw = await this.app.vault.read(this.file);
        } catch (err) {
            console.error(err);
            contentEl.createDiv({ cls: "highlight-edit-error", text: "Could not read file." });
            return;
        }

        const parsed = parseHighlights(raw);
        const highlight = findHighlightById(parsed, this.highlightId);
        if (!highlight) {
            contentEl.createDiv({ cls: "highlight-edit-error", text: "Highlight not found (it may have moved)." });
            return;
        }

        this.state.color = highlight.color;

        const preview = contentEl.createDiv({ cls: "highlight-edit-preview" });
        preview.createDiv({ cls: "highlight-edit-preview-label", text: "Preview" });
        preview.createDiv({ cls: "highlight-edit-preview-text", text: highlight.text || "" });

        new Setting(contentEl)
            .setName("Colour")
            .setDesc(
                highlight.type === "html"
                    ? "This is an HTML highlight from an older version. Applying turns it into a native highlight."
                    : "Written as an Obsidian highlight colour, e.g. ==🟡text==."
            )
            .addDropdown((drop) => {
                drop.addOption("", "Theme default");
                for (const color of HIGHLIGHT_COLORS) {
                    drop.addOption(color, COLOR_LABELS[color]);
                }
                drop.setValue(this.state.color ?? "");
                drop.onChange((value) => {
                    this.state.color = isHighlightColor(value) ? value : null;
                });
            });

        const footer = contentEl.createDiv({ cls: "modal-footer highlight-edit-footer" });

        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();

        const removeBtn = footer.createEl("button", { text: "Remove highlight" });
        removeBtn.onclick = () => void this.applyEdits({ remove: true });

        const applyBtn = footer.createEl("button", { text: "Apply", cls: "mod-cta" });
        applyBtn.onclick = () => void this.applyEdits({ remove: false });
    }

    async applyEdits({ remove }: { remove: boolean }) {
        try {
            await this.plugin.saveUndoState(this.file);

            const finalRaw = await this.app.vault.process(this.file, (data) => {
                let raw = data;
                const parsed = parseHighlights(raw);
                const highlight = findHighlightById(parsed, this.highlightId);
                if (!highlight) {
                    throw new Error("Highlight not found (it may have moved).");
                }

                if (remove) {
                    raw = removeHighlightFromRaw(raw, highlight);
                    return raw;
                }

                if (highlight.type === "html" || highlight.color !== this.state.color) {
                    raw = updateHighlightColorInRaw(raw, highlight, this.state.color);
                }
                return raw;
            });

            await this.plugin.recordUndoResult(this.file, finalRaw);
            this.onApplied(finalRaw);
            this.close();
            new Notice(remove ? "Highlight removed." : "Highlight updated.");
        } catch (err) {
            console.error(err);
            new Notice(err instanceof Error ? err.message : "Failed to update highlight.");
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
