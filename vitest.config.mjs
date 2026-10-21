import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    resolve: {
        // `obsidian` ships type declarations only, so tests that import plugin
        // modules need a runtime stand-in for its exports.
        alias: { obsidian: fileURLToPath(new URL("./tests/obsidian-stub.js", import.meta.url)) },
    },
    test: {
        include: ["tests/**/*.test.js"],
        environment: "jsdom",
        setupFiles: ["./tests/setup.js"],
    },
});
