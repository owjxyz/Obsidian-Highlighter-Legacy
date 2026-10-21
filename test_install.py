"""Run with python3 test_install.py; all installations use temporary vaults."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import install


assets = {
    "main.js": b"module.exports = class {};\n",
    "styles.css": b".test { color: red; }\n",
    "manifest.json": json.dumps({"id": install.PLUGIN, "version": install.VERSION}).encode(),
}
install.ASSETS = {name: hashlib.sha256(content).hexdigest() for name, content in assets.items()}
install.download = lambda url: assets[url.rsplit("/", 1)[1]]


with TemporaryDirectory() as directory:
    vault = Path(directory) / "테스트 Vault"
    config = vault / ".obsidian"
    legacy = config / "plugins" / install.LEGACY
    legacy.mkdir(parents=True)
    settings = b'{"toolbarPosition":"left","defaultHighlightColor":"purple"}\n'
    (legacy / "data.json").write_bytes(settings)
    enabled = config / "community-plugins.json"
    enabled.write_text(json.dumps(["other", install.LEGACY]))
    keys = config / "hotkeys.json"
    original = {
        "other:command": [{"modifiers": ["Alt"], "key": "R"}],
        install.LEGACY + ":apply-color-1": [{"modifiers": ["Ctrl", "Shift"], "key": "R"}],
    }
    keys.write_text(json.dumps(original))
    original_bytes = keys.read_bytes()
    backup = install.install(vault)
    assert (backup / "hotkeys.json").read_bytes() == original_bytes
    assert json.loads(enabled.read_bytes()) == ["other", install.PLUGIN]
    merged = json.loads(keys.read_bytes())
    assert merged[install.PLUGIN + ":apply-color-1"] == original[install.LEGACY + ":apply-color-1"]
    assert merged[install.LEGACY + ":apply-color-1"] == []
    assert merged["other:command"] == original["other:command"]
    target = config / "plugins" / install.PLUGIN
    assert json.loads((target / "data.json").read_bytes())["toolbarPosition"] == "left"
    assert (legacy / "data.json").read_bytes() == settings
    assert install.install(vault) is None

    # A failed or corrupted download must not change existing settings.
    before = keys.read_bytes()
    assets["main.js"] = b"tampered"
    try:
        install.install(vault)
        raise AssertionError("Accepted a corrupted asset")
    except ValueError as error:
        assert "Checksum" in str(error)
    assert keys.read_bytes() == before
    assets["main.js"] = b"module.exports = class {};\n"

    # Conflicts are explicit, and replacing one does not delete other bindings.
    merged["other:conflict"] = [{"modifiers": ["Ctrl"], "key": "S"}, {"modifiers": ["Alt"], "key": "V"}]
    keys.write_text(json.dumps(merged))
    before = keys.read_bytes()
    try:
        install.install(vault)
        raise AssertionError("Accepted a shortcut conflict")
    except ValueError as error:
        assert "conflict" in str(error).lower()
    assert keys.read_bytes() == before
    install.install(vault, replace_conflicts=True)
    assert json.loads(keys.read_bytes())["other:conflict"] == [{"modifiers": ["Alt"], "key": "V"}]

    # An interrupted write rolls back already-written settings.
    keys.write_text("{}")
    before = keys.read_bytes()
    actual_write = install.atomic_write
    def fail_once(path, content):
        if path == keys:
            actual_write(path, content)
            return
        raise OSError("simulated write failure")
    install.atomic_write = fail_once
    enabled.write_text("[]")
    try:
        install.install(vault)
        raise AssertionError("Expected a write failure")
    except OSError:
        pass
    finally:
        install.atomic_write = actual_write
    assert keys.read_bytes() == before

    # Symlinks cannot redirect installer writes outside the vault.
    keys.unlink()
    outside = Path(directory) / "outside.json"
    outside.write_text("{}")
    keys.symlink_to(outside)
    try:
        install.install(vault)
        raise AssertionError("Accepted a symlink")
    except ValueError:
        pass
    assert outside.read_text() == "{}"

print("PASS: checksums, migration, backups, repeat install, conflicts, rollback, symlink protection")
