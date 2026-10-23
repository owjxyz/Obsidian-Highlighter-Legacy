"""Run after npm run build: python3 test_metadata.py."""
import json
from pathlib import Path


root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text())
assert manifest["id"] == "superior-highlighter"
assert manifest["name"] == "Superior Highlighter"
assert manifest["author"] == "WooJIN OH"
assert manifest["authorUrl"] == "https://github.com/owjxyz"

for name in ("main.js", "manifest.json", "styles.css"):
    content = (root / name).read_bytes()
    assert (root / "build" / name).read_bytes() == content, f"Stale build/{name}"
    assert b"Reader Highlighter Tags" not in content, f"Legacy branding in {name}"
    assert b"DuckTapeKiller" not in content, f"Legacy author in {name}"

print("PASS: current plugin identity and matching distribution files")
