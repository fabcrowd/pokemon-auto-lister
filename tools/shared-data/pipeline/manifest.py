"""The manifest the extension downloads first: what the pack is for, how to check it, how well it did."""
import hashlib
import json

from .signing import sign_bytes, verify_signature

MIN_EXAM_CASES = 30

__all__ = ["build_manifest", "is_improved", "manifest_bytes", "sign_bytes", "verify_signature"]


def is_improved(exam):
    """The pack helps only if it beat the plain catalog on at least 30 held-out cards."""
    return exam["after"] > exam["before"] and exam["n"] >= MIN_EXAM_CASES


def build_manifest(pins, clip, catalog, entries, pack_bytes, url, exam):
    """clip / catalog are the first 16 hex digits of the model and catalog sha256; crop is EMBEDDING_VERSION."""
    return {
        "v": 1,
        "model": clip,
        "catalog": catalog,
        "crop": pins["cropVersion"],
        "entries": entries,
        "dim": pins["dim"],
        "sha256": hashlib.sha256(pack_bytes).hexdigest(),
        "url": url,
        "exam": exam,
        "improved": is_improved(exam),
    }


def manifest_bytes(manifest):
    """The exact bytes that are published as manifest.json and signed."""
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
