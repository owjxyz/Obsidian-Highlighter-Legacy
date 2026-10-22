import { describe, it, expect, vi } from "vitest";
import ReadingHighlighterPlugin from "../src/main";

const shortcuts = [
    ["highlight-selection-reading", "editor:toggle-highlight"],
    ["apply-color-1", "editor:toggle-highlight-red"],
    ["apply-color-2", "editor:toggle-highlight-orange"],
    ["apply-color-3", "editor:toggle-highlight-yellow"],
    ["apply-color-4", "editor:toggle-highlight-green"],
    ["apply-color-5", "editor:toggle-highlight-blue"],
    ["apply-color-6", "editor:toggle-highlight-purple"],
];

describe("highlight shortcut routing", () => {
    it.each(shortcuts)("delegates %s to %s in the editor and keeps the reading action", (id, nativeId) => {
        let mode = "source";
        let editorFocused = true;
        const view = { getMode: () => mode };
        const nativeRuns = [];
        const plugin = new ReadingHighlighterPlugin(
            {
                workspace: { getActiveViewOfType: () => view, activeEditor: view },
                commands: {
                    findCommand: (commandId) => {
                        expect(commandId).toBe(nativeId);
                        return {
                            checkCallback: (checking) => {
                                if (!editorFocused || plugin.app.workspace.activeEditor.getMode() !== "source")
                                    return false;
                                if (!checking) nativeRuns.push(commandId);
                                return true;
                            },
                        };
                    },
                },
            },
            {}
        );
        const registered = [];
        plugin.addCommand = (command) => registered.push(command);
        plugin.highlightSelection = vi.fn();
        plugin.applyColorByIndex = vi.fn();
        plugin.registerCommands();
        const command = registered.find((entry) => entry.id === id);
        expect(command.checkCallback(true)).toBe(true);
        expect(nativeRuns).toEqual([]);
        expect(command.checkCallback(false)).toBe(true);
        expect(nativeRuns).toEqual([nativeId]);
        expect(plugin.highlightSelection).not.toHaveBeenCalled();
        expect(plugin.applyColorByIndex).not.toHaveBeenCalled();

        editorFocused = false;
        expect(command.checkCallback(true)).toBe(false);
        expect(command.checkCallback(false)).toBe(false);
        expect(nativeRuns).toEqual([nativeId]);
        const findCommand = plugin.app.commands.findCommand;
        plugin.app.commands.findCommand = () => undefined;
        expect(command.checkCallback(true)).toBe(false);
        plugin.app.commands.findCommand = findCommand;

        mode = "preview";
        expect(command.checkCallback(true)).toBe(true);
        expect(command.checkCallback(false)).toBe(true);
        if (id === "highlight-selection-reading") {
            expect(plugin.highlightSelection).toHaveBeenCalledWith(view, null, true);
        } else {
            expect(plugin.applyColorByIndex).toHaveBeenCalledWith(view, Number(id.at(-1)) - 1, null, true);
        }
        expect(nativeRuns).toEqual([nativeId]);

        // Clicking a footnote preview focuses its editor while the note stays in Reading View.
        const popup = { getMode: () => "source" };
        plugin.app.workspace.activeEditor = popup;
        editorFocused = true;
        plugin.highlightSelection.mockClear();
        plugin.applyColorByIndex.mockClear();
        expect(command.checkCallback(true)).toBe(true);
        expect(nativeRuns).toEqual([nativeId]);
        expect(command.checkCallback(false)).toBe(true);
        expect(nativeRuns).toEqual([nativeId, nativeId]);
        expect(plugin.highlightSelection).not.toHaveBeenCalled();
        expect(plugin.applyColorByIndex).not.toHaveBeenCalled();

        // Returning focus to the reading note restores the plugin's reading action.
        plugin.app.workspace.activeEditor = view;
        expect(command.checkCallback(false)).toBe(true);
        expect(nativeRuns).toEqual([nativeId, nativeId]);
        if (id === "highlight-selection-reading") {
            expect(plugin.highlightSelection).toHaveBeenCalledWith(view, null, true);
        } else {
            expect(plugin.applyColorByIndex).toHaveBeenCalledWith(view, Number(id.at(-1)) - 1, null, true);
        }
    });
});
