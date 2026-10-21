[KOREAN](README.ko.md)

# Superier Highlighter

Highlight exactly what you select in Obsidian Reading View. Matches the selected text together with the text before and after it, then saves native `==🔴text==` highlights.

**Author:** [owjxyz](https://github.com/owjxyz)

## Install

Close Obsidian, open a terminal in your vault folder, and run:

```sh
curl -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superier-Highlighter/main/install.py | python3 -
```

- An optional vault path can be added after `python3 -`.
- Requires Python 3.9+. Resolves the latest stable release on every run and verifies checksums for all three release files.
- Backs up changed files, preserves other settings, and migrates Reader Highlighter Tags plugin settings. The old plugin is disabled; its files stay in place.
- Does not add or change shortcuts. Apply personal shortcuts through [Obsidian Vault Init](https://github.com/owjxyz/Obsidian-Vault-Init).
- Existing Superier Highlighter settings are preserved.
- Updates happen when you run the script; it does not install a background updater. Preview releases are excluded. If release lookup or verification fails, the vault stays unchanged.

Manual installation: download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/owjxyz/Obsidian-Superier-Highlighter/releases/latest), place them in `.obsidian/plugins/superier-highlighter/`, then enable **Superier Highlighter**. Community-directory installation becomes available after Obsidian approves the submission.

## Shortcuts

Assign your preferred keys to colour and removal commands in **Settings → Hotkeys → Superier Highlighter**. Select text in Reading View and press the assigned shortcut.

**Repeat a highlight shortcut:** if an existing highlight contains the selection, its entire highlight and colour marker are removed. Otherwise the shortcut highlights the selection. This also works per line or cell in a multi-line selection.

Toolbar colour buttons recolour only the selected part. The remove button and removal command erase only the selected part, keeping surrounding highlights intact.

## Selection behaviour

- Partial first/last lines and table cells remain partial. Text outside the selection keeps its colour.
- Surrounding text, repeated-paragraph order, and visible occurrence counts must agree. Ambiguous or stale selections leave the note unchanged.
- A selection spanning an embedded note is refused. Select inside one note at a time.
- Partial link labels and partial inline-code spans are refused rather than expanded. Select their complete visible text.
- Unrecognized rendered syntax may be refused. Smart paragraph selection deliberately selects a full block when enabled; it is off by default.

Tags, footnote annotations, highlight navigation, exports, and reading progress are retained from the original plugin.

## Develop

Requires Node.js and Python:

```sh
npm ci
npm test
npm run typecheck
npm run build
python3 test_install.py
```

## Credits

Derived from [Reader Highlighter Tags](https://github.com/DuckTapeKiller/obsidian-reader-highlighter-tags) by DuckTapeKiller, under the [MIT license](LICENSE). Superier Highlighter is an independent fork maintained by owjxyz.
