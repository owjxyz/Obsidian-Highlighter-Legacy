#!/usr/bin/env python3
"""Install Superier Highlighter 0.0.1 into an existing, closed Obsidian vault."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

PLUGIN = "superier-highlighter"
LEGACY = "reader-highlighter-tags"
VERSION = "0.0.1"
REPOSITORY = "owjxyz/Obsidian-Superier-Highlighter"
ASSETS = {
    "main.js": "3627ab379655740b95eaba7972e50243b31095d62f9d480ab31102d032ce8ad3",
    "manifest.json": "02e8678d390f5745499b71ff60693ef3184133c81000b6162ae646150523a021",
    "styles.css": "96ff6264408b54bfcef7ac68a4cc2beacb86f19d1b9feb835672e890c3735406"
}
DEFAULT_HOTKEYS = {
    "apply-color-1": "A", "apply-color-3": "S", "apply-color-4": "Z",
    "apply-color-6": "X", "remove-highlight": "Q",
}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Superier-Highlighter-Installer"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def merge_hotkeys(raw, preset, replace_conflicts):
    # Reuse Basic Color Highlighter's validation and merge rules.
    current = json.loads(raw)
    if not isinstance(current, dict):
        raise ValueError("hotkeys.json must contain a JSON object.")
    for command, bindings in current.items():
        if not isinstance(bindings, list):
            raise ValueError(f"Invalid hotkeys for {command}.")
        for binding in bindings:
            if (not isinstance(binding, dict)
                    or not isinstance(binding.get("key"), str) or not binding["key"]
                    or not isinstance(binding.get("modifiers"), list)
                    or any(not isinstance(mod, str) or mod not in {"Mod", "Ctrl", "Meta", "Alt", "Shift"}
                           for mod in binding["modifiers"])):
                raise ValueError(f"Invalid key combination for {command}.")
    def combination(binding):
        modifiers = {("Meta" if sys.platform == "darwin" else "Ctrl") if mod == "Mod" else mod
                     for mod in binding["modifiers"]}
        return frozenset(modifiers), binding["key"].upper()

    reserved = {combination(binding) for bindings in preset.values() for binding in bindings}
    merged = dict(current)
    for command, bindings in current.items():
        if command in preset:
            continue
        remaining = [binding for binding in bindings
                     if combination(binding) not in reserved]
        if len(remaining) != len(bindings):
            if not replace_conflicts:
                raise ValueError(f"Hotkey conflict: {command}. Use --replace-conflicts to reassign it.")
            merged[command] = remaining
    merged.update(preset)
    return json_bytes(merged)


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if path.exists():
            temporary.chmod(path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def install(vault, replace_conflicts=False):
    config = vault.expanduser().resolve() / ".obsidian"
    if not config.is_dir():
        raise ValueError("Choose an existing vault containing .obsidian.")
    config = config.resolve()
    enabled_path = config / "community-plugins.json"
    keys_path = config / "hotkeys.json"
    enabled = json.loads(enabled_path.read_bytes()) if enabled_path.exists() else []
    if not isinstance(enabled, list) or any(not isinstance(item, str) for item in enabled):
        raise ValueError("community-plugins.json must contain a list of plugin IDs.")
    original_keys = keys_path.read_bytes() if keys_path.exists() else b"{}"
    keys = json.loads(original_keys)
    if not isinstance(keys, dict):
        raise ValueError("hotkeys.json must contain an object.")
    preset = {}
    for command, bindings in keys.items():
        if command.startswith(LEGACY + ":"):
            new_command = PLUGIN + command[len(LEGACY):]
            preset[new_command] = keys.get(new_command, bindings)
            preset[command] = []
    for command, key in DEFAULT_HOTKEYS.items():
        new_command = PLUGIN + ":" + command
        preset.setdefault(new_command, keys.get(new_command, [{"modifiers": ["Ctrl"], "key": key}]))
    updates = {keys_path: merge_hotkeys(original_keys, preset, replace_conflicts)}
    if set(ASSETS) != {"main.js", "manifest.json", "styles.css"}:
        raise ValueError("The installer has no verified release checksums.")
    for name, digest in ASSETS.items():
        content = download(f"https://github.com/{REPOSITORY}/releases/download/{VERSION}/{name}")
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f"Checksum mismatch: {name}. No settings were changed.")
        if name == "manifest.json":
            metadata = json.loads(content)
            if metadata.get("id") != PLUGIN or metadata.get("version") != VERSION:
                raise ValueError("Unexpected release manifest.")
        updates[config / "plugins" / PLUGIN / name] = content
    data = config / "plugins" / PLUGIN / "data.json"
    legacy_data = config / "plugins" / LEGACY / "data.json"
    if not data.exists() and legacy_data.exists():
        legacy_data.resolve().relative_to(config)
        settings = json.loads(legacy_data.read_bytes())
        if not isinstance(settings, dict):
            raise ValueError("Legacy settings must contain an object.")
        updates[data] = json_bytes(settings)
    enabled = [item for item in enabled if item != LEGACY]
    if PLUGIN not in enabled:
        enabled.append(PLUGIN)
    updates[enabled_path] = json_bytes(enabled)
    before = {}
    for path in updates:
        path.resolve().relative_to(config)
        if path.is_symlink():
            raise ValueError(f"Refusing to replace a symlink: {path}")
        before[path] = path.read_bytes() if path.exists() else None
    changes = {path: content for path, content in updates.items() if content != before[path]}
    if not changes:
        print("Already installed; no files changed.")
        return None
    backup = config / "superier-highlighter-backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup.resolve().relative_to(config)
    backup.mkdir(parents=True)
    for path in changes:
        if before[path] is not None:
            saved = backup / path.relative_to(config)
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(before[path])
    (backup / "created-files.json").write_bytes(json_bytes([str(path.relative_to(config)) for path in changes if before[path] is None]))
    written = []
    try:
        # ponytail: offline installer; close Obsidian. Live updates need in-app coordination.
        for path, content in changes.items():
            if (path.read_bytes() if path.exists() else None) != before[path]:
                raise ValueError("Settings changed during installation. Close Obsidian and retry.")
            atomic_write(path, content)
            written.append(path)
    except Exception:
        for path in reversed(written):
            if path.read_bytes() != changes[path]:
                print(f"Preserved concurrent edit during rollback: {path}", file=sys.stderr)
                continue
            if before[path] is None:
                path.unlink()
            else:
                atomic_write(path, before[path])
        raise
    print(f"Installed Superier Highlighter {VERSION}. Reopen Obsidian.")
    print(f"Backup: {backup}")
    return backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault", nargs="?", type=Path, default=Path.cwd())
    parser.add_argument("--replace-conflicts", action="store_true", help="Replace only conflicting shortcut bindings.")
    args = parser.parse_args()
    try:
        install(args.vault, args.replace_conflicts)
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
