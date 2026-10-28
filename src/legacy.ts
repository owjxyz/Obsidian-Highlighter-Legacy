import { Notice, Plugin } from "obsidian";

export default class LegacyHighlighter extends Plugin {
    onload() {
        new Notice(
            "This legacy version is retired. Disable it and install superior highlighter from community plugins. Existing notes and settings are preserved.",
            15000
        );
    }
}
