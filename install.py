#!/usr/bin/env python3
"""Install the latest stable Superior Highlighter release into an existing, closed Obsidian vault."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.request
from urllib.parse import quote

PLUGIN = "superior-highlighter"
LEGACY = "reader-highlighter-tags"
REPOSITORY = "owjxyz/Obsidian-Superior-Highlighter"
ASSETS = ("main.js", "manifest.json", "styles.css")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Superior-Highlighter-Installer"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


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


def install(vault):
    config = vault.expanduser().resolve() / ".obsidian"
    if not config.is_dir():
        raise ValueError("Choose an existing vault containing .obsidian.")
    config = config.resolve()
    enabled_path = config / "community-plugins.json"
    enabled = json.loads(enabled_path.read_bytes()) if enabled_path.exists() else []
    if not isinstance(enabled, list) or any(not isinstance(item, str) for item in enabled):
        raise ValueError("community-plugins.json must contain a list of plugin IDs.")
    release = json.loads(download(f"https://api.github.com/repos/{REPOSITORY}/releases/latest"))
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not tag or release.get("draft") or release.get("prerelease"):
        raise ValueError("No stable release is available.")
    version = tag.removeprefix("v")
    names = {asset["name"] for asset in release.get("assets", [])}
    if not {*ASSETS, "SHA256SUMS"}.issubset(names):
        raise ValueError("The latest release is missing required files or checksums.")
    base = f"https://github.com/{REPOSITORY}/releases/download/{quote(tag, safe='')}/"
    checksums = {}
    for line in download(base + "SHA256SUMS").decode("utf-8").splitlines():
        if line.strip():
            digest, name = line.split(maxsplit=1)
            checksums[name.lstrip(" *")] = digest
    updates = {}
    for name in ASSETS:
        content = download(base + name)
        if hashlib.sha256(content).hexdigest() != checksums.get(name):
            raise ValueError(f"Checksum mismatch: {name}. No settings were changed.")
        if name == "manifest.json":
            metadata = json.loads(content)
            if not isinstance(metadata, dict) or metadata.get("id") != PLUGIN or metadata.get("version") != version:
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
    backup = config / "superior-highlighter-backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
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
    print(f"Installed Superior Highlighter {version}. Reopen Obsidian.")
    print(f"Backup: {backup}")
    return backup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault", nargs="?", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        install(args.vault)
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
