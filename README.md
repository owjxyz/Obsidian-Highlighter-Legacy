# Superior Highlighter (Legacy)

**Retired as of 0.1.3.** This release is an inert legacy placeholder that only shows a migration notice. It does not highlight, read or edit notes, access the clipboard, or change settings. Disable this legacy plugin and install [Superior Highlighter](https://community.obsidian.md/plugins/superior-highlighter), maintained in [Obsidian-Highlighter](https://github.com/owjxyz/Obsidian-Highlighter). Existing notes and settings remain untouched. The functionality described below is historical and applies only to versions through 0.1.2.

Highlight exactly what you select in Obsidian Reading View. Matches the selected text together with the text before and after it, then saves native `==🔴text==` highlights.

**Author:** [WooJIN OH (owjxyz)](https://github.com/owjxyz)

[GitHub repository](https://github.com/owjxyz/Obsidian-Superior-Highlighter) · [Obsidian community listing](https://obsidian.md/plugins?id=superier-highlighter)

[KOREAN](README.ko.md) · [ENGLISH](README.md)

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **Superior Highlighter (Legacy)** by **WooJIN OH**, then install and enable it. You can also open its [community listing](https://obsidian.md/plugins?id=superier-highlighter).

For the terminal installer, follow the instructions below.

Close Obsidian, open a terminal in your vault folder, and run:

**macOS (Terminal)**

```sh
curl -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superior-Highlighter/main/install.py | python3 -
```

**Windows (PowerShell)**

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superior-Highlighter/main/install.py | py -3 -
```

Use `curl.exe` explicitly: Windows PowerShell 5.1 aliases `curl` to `Invoke-WebRequest`, which does not accept `-fsSL`. If `py` is unavailable but `python --version` reports Python 3.9+, replace `py -3 -` with `python -`.

- An optional vault path can be added after `python3 -` (macOS) or `py -3 -` (Windows). Quote paths containing spaces, for example `python3 - "/Users/you/Obsidian Vault"` or `py -3 - "C:\Users\you\Documents\Obsidian Vault"` at the end of the command.
- Requires Python 3.9+. Resolves the latest stable release on every run and verifies checksums for all three release files.
- Backs up changed files, preserves other settings, and migrates Reader Highlighter Tags plugin settings. The old plugin is disabled; its files stay in place.
- Does not add or change shortcuts. Apply personal shortcuts through [Obsidian Vault Init](https://github.com/owjxyz/Obsidian-Vault-Init).
- Existing Superior Highlighter (Legacy) settings are preserved.
- Updates happen when you run the script; it does not install a background updater. Preview releases are excluded. If release lookup or verification fails, the vault stays unchanged.

Manual installation: download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/owjxyz/Obsidian-Superior-Highlighter/releases/latest), place them in `.obsidian/plugins/superier-highlighter/`, then enable **Superior Highlighter (Legacy)**.

## Shortcuts

Assign your preferred keys to colour and removal commands in **Settings → Hotkeys → Superior Highlighter (Legacy)**. Select text in Reading View and press the assigned shortcut.

**Colour highlight shortcuts:** if a highlight contains the selection and already has the requested colour, the entire highlight is removed. A different colour recolours only the selection, keeping surrounding colours intact. Unhighlighted text receives the requested colour. This rule applies separately to each selected line or cell.

The generic highlight toggle shortcut removes a containing highlight regardless of its colour, or highlights the selection if none contains it.

Toolbar colour buttons recolour only the selected part. The remove button and removal command erase only the selected part, keeping surrounding highlights intact.

## Selection behaviour

- Partial first/last lines and table cells remain partial. Text outside the selection keeps its colour.
- Surrounding text, repeated-paragraph order, and visible occurrence counts must agree. Ambiguous or stale selections leave the note unchanged.
- A selection spanning an embedded note is refused. Select inside one note at a time.
- Partial link labels and partial inline-code spans are refused rather than expanded. Select their complete visible text.
- Unrecognized rendered syntax may be refused. Smart paragraph selection deliberately selects a full block when enabled; it is off by default.

## Highlight management

The current-note navigator supports search, colour editing, individual and full-note removal, merging adjacent highlights, bulk recolouring, conversion of older HTML highlights, and undoing the last change.

Tag management, footnote annotations, quote copying, global research, exports, PDF support, and reading progress have been removed. Tags, footnotes, and quotes already stored in notes remain intact. Only supported highlight options are loaded from older plugin settings.

## Data access

The plugin reads and edits the note containing the selection, including the source of an embedded note. It does not scan the vault or process PDFs. **Copy** in the highlight navigator writes only the chosen item's text to the system clipboard; existing clipboard contents are not read. Note contents, file paths, and clipboard contents are not sent to a server.

## Release verification

The release workflow builds and tests main-branch updates and version tags in GitHub Actions, checks their committed checksums, and generates GitHub artifact attestations for `main.js`, `manifest.json`, and `styles.css`. Only a version tag prepares a release draft using those same files; publishing remains a separate, deliberate step. Manually running **Verify release provenance** builds and attests the selected ref without creating a release when that ref is a branch.

For a release produced by this workflow, download its assets and verify their build provenance with `gh attestation verify main.js --repo owjxyz/Obsidian-Superior-Highlighter` (repeat for `manifest.json` and `styles.css`). Only these three files are attached to new releases. The installer verifies GitHub Releases API SHA-256 digests; `SHA256SUMS` stays in the repository for CI verification. Existing releases are not changed by adding the workflow.

## Develop

Requires Node.js and Python:

```sh
npm ci
npm test
npm run typecheck
npm run build
python3 test_metadata.py
python3 test_install.py
```

On Windows PowerShell, use `py -3 test_metadata.py` and `py -3 test_install.py` for the last two commands (or `python` instead of `py -3` if configured as described above). The `npm` commands are the same on both platforms.

## Credits

Derived from [Reader Highlighter Tags](https://github.com/DuckTapeKiller/obsidian-reader-highlighter-tags) by DuckTapeKiller, under the [MIT license](LICENSE). Superior Highlighter (Legacy) is an independent fork maintained by WooJIN OH (owjxyz).
