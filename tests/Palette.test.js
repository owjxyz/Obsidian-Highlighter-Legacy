// The fixed palette keeps all six native colours and their shortcut indices.
import { describe, it, expect } from "vitest";
import { FloatingManager } from "../src/ui/FloatingManager";
import { createObsidianWindow } from "./dom-helpers.js";

function makeManager(colors, showOnlyAssignedColors) {
    const window = createObsidianWindow();
    const applied = [];
    const view = { getMode: () => "preview" };
    const plugin = {
        app: { workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {} } },
        settings: {
            enableColorPalette: true,
            showOnlyAssignedColors,
            semanticColors: colors,
            showRemoveButton: false,
            toolbarPosition: "right",
        },
        getActiveReadingView: () => view,
        applyColorByIndex: (_v, index) => applied.push(index),
    };
    return { manager: new FloatingManager(plugin), applied, window };
}

const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "red", "orange"];
const palette = (meanings) => meanings.map((meaning, i) => ({ color: COLORS[i], meaning }));

describe("toolbar palette swatches", () => {
    it("draws each button as the native colour it applies, with its name as the label", () => {
        const { manager } = makeManager(palette(["", "", "", "", "", ""]), true);
        manager.createElements();
        const buttons = [...manager.paletteContainer.querySelectorAll("button")];
        expect(
            buttons.map((b) => b.querySelector(".reading-highlighter-swatch").getAttribute("data-highlight"))
        ).toEqual(["red", "orange", "yellow", "green", "blue", "purple"]);
        expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
            "Red",
            "Orange",
            "Yellow",
            "Green",
            "Blue",
            "Purple",
        ]);
        // No inline colour: the theme's --color-* variables paint them.
        expect(buttons.every((b) => !b.getAttribute("style"))).toBe(true);
    });

    it("builds the toolbar as a menu of icon buttons, so the theme styles it", () => {
        const { manager } = makeManager(palette(["", ""]), true);
        manager.createElements();
        expect(manager.containerEl.classList.contains("menu")).toBe(true);
        const buttons = [...manager.containerEl.querySelectorAll("button")];
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.every((b) => b.classList.contains("clickable-icon"))).toBe(true);
    });
});

describe("fixed six-colour palette", () => {
    it("ignores old meanings and filtering options", () => {
        const { manager } = makeManager(palette(["Important", "", "", "", "", "Definition"]), true);
        manager.createElements();
        const buttons = [...manager.paletteContainer.querySelectorAll("button")];
        expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
            "Red",
            "Orange",
            "Yellow",
            "Green",
            "Blue",
            "Purple",
        ]);
        expect(buttons.map((button) => button.getAttribute("data-color-index"))).toEqual([
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
        ]);
    });

    it("keeps all six buttons when old palette data is absent", () => {
        const { manager } = makeManager(undefined, true);
        manager.createElements();
        expect(manager.colorButtons).toHaveLength(6);
    });

    it("routes every colour button to the matching shortcut index", () => {
        const { manager, applied, window } = makeManager(palette(["Important"]), true);
        manager.load();
        expect(manager.colorButtons).toHaveLength(6);
        for (const button of manager.colorButtons) {
            button.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
        }
        expect(applied).toEqual([0, 1, 2, 3, 4, 5]);
    });
});
