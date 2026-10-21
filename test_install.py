"""Run with python3 test_install.py; all installations use temporary vaults."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import install


assets = {
    "main.js": b"module.exports = class {};\n",
    "styles.css": b".test { color: red; }\n",
    "manifest.json": json.dumps({"id": install.PLUGIN, "version": "9.8.7"}).encode(),
}
checksums = {name: hashlib.sha256(content).hexdigest() for name, content in assets.items()}
release = {"tag_name": "v9.8.7", "assets": [{"name": name} for name in [*assets, "SHA256SUMS"]]}

def fixture_download(url):
    if url == f"https://api.github.com/repos/{install.REPOSITORY}/releases/latest":
        return json.dumps(release).encode()
    assert "/releases/download/v9.8.7/" in url, url
    name = url.rsplit("/", 1)[1]
    if name == "SHA256SUMS":
        return "".join(f"{digest}  {name}\n" for name, digest in checksums.items()).encode()
    return assets[name]

install.download = fixture_download


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
    assert not (backup / "hotkeys.json").exists()
    assert json.loads(enabled.read_bytes()) == ["other", install.PLUGIN]
    assert keys.read_bytes() == original_bytes, "Plugin installation must not alter shortcuts"
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

    # The standalone plugin installer never creates or parses shortcut settings.
    fresh = Path(directory) / "Fresh Vault"
    (fresh / ".obsidian").mkdir(parents=True)
    install.install(fresh)
    assert not (fresh / ".obsidian/hotkeys.json").exists()
    keys.write_bytes(b"malformed settings must be left alone")
    assert install.install(vault) is None
    assert keys.read_bytes() == b"malformed settings must be left alone"

    # A newly published release is resolved again on the next invocation.
    release["tag_name"] = "v9.8.8"
    assets["manifest.json"] = json.dumps({"id": install.PLUGIN, "version": "9.8.8"}).encode()
    checksums["manifest.json"] = hashlib.sha256(assets["manifest.json"]).hexdigest()
    def next_release(url):
        return fixture_download(url.replace("/v9.8.8/", "/v9.8.7/"))
    install.download = next_release
    install.install(vault)
    assert json.loads((target / "manifest.json").read_bytes())["version"] == "9.8.8"

    # Incomplete, preview or mismatched latest releases never replace installed files.
    original_manifest = assets["manifest.json"]
    original_release = dict(release)
    installed_manifest = (target / "manifest.json").read_bytes()
    for problem in ["preview", "missing", "manifest"]:
        release.clear()
        release.update(original_release)
        if problem == "preview":
            release["prerelease"] = True
        elif problem == "missing":
            release["assets"] = [{"name": "main.js"}]
        else:
            assets["manifest.json"] = b'{"id":"wrong-plugin","version":"9.8.8"}'
            checksums["manifest.json"] = hashlib.sha256(assets["manifest.json"]).hexdigest()
        try:
            install.install(vault)
            raise AssertionError("Accepted an invalid latest release")
        except ValueError:
            pass
        assert (target / "manifest.json").read_bytes() == installed_manifest
    release.clear()
    release.update(original_release)
    assets["manifest.json"] = original_manifest
    checksums["manifest.json"] = hashlib.sha256(original_manifest).hexdigest()

    # An interrupted plugin write restores the old binary.
    main = target / "main.js"
    styles = target / "styles.css"
    main.write_bytes(b"old main")
    styles.write_bytes(b"old css")
    actual_write = install.atomic_write
    def fail_once(path, content):
        if path == styles.resolve():
            raise OSError("simulated write failure")
        actual_write(path, content)
    install.atomic_write = fail_once
    try:
        install.install(vault)
        raise AssertionError("Expected a write failure")
    except OSError:
        pass
    finally:
        install.atomic_write = actual_write
    assert main.read_bytes() == b"old main"
    assert styles.read_bytes() == b"old css"

    # Symlinks cannot redirect installer writes outside the vault.
    main.unlink()
    outside = Path(directory) / "outside.js"
    outside.write_text("{}")
    main.symlink_to(outside)
    try:
        install.install(vault)
        raise AssertionError("Accepted a symlink")
    except ValueError:
        pass
    assert outside.read_text() == "{}"

print("PASS: plugin-only installation, shortcuts untouched, checksums, settings migration, backups, rollback, symlink protection")
