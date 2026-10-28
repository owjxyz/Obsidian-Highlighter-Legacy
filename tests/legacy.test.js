import { expect, test } from "vitest";
import { Notice } from "obsidian";
import LegacyHighlighter from "../src/legacy";

test("legacy placeholder announces retirement without accessing vault or settings", () => {
    const app = new Proxy(
        {},
        {
            get: () => {
                throw new Error("Unexpected app access");
            },
        }
    );
    const plugin = new LegacyHighlighter();
    plugin.app = app;
    plugin.loadData = plugin.saveData = () => {
        throw new Error("Unexpected settings access");
    };
    Notice.messages.length = 0;
    plugin.onload();
    expect(Notice.messages).toEqual([
        "This legacy version is retired. Disable it and install superior highlighter from community plugins. Existing notes and settings are preserved.",
    ]);
});
