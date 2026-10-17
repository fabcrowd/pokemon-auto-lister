#!/usr/bin/env python3
"""Verifies the build job's output and signs manifest.json. Runs in the `sign` job, the only place the key exists.

    PACK_SIGNING_KEY=<PKCS8 PEM> python scripts/sign_release.py --dir out --url <pack url> --run-number <n>

Deliberately self-contained: it imports nothing but the standard library and `cryptography`, and none of the
pipeline code, so a change to the (unprivileged) pipeline cannot reach the key. It refuses to sign unless
  * the manifest has exactly the known fields and the pack's sha256, size and entries match it,
  * the pack is well formed with at most MAX_ENTRIES rows of non-empty card ids,
  * url is this run's release asset, seq is this run's number and issuedAt is within an hour of now,
  * `improved` equals what the numbers say: exam after > before on at least 30 cards, and no drop on the
    regression set (which must be present and non-empty).
"""
import argparse
import base64
import datetime
import hashlib
import json
import math
import os
import re
import struct
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

MAX_ENTRIES = 20000
MAX_HEADER = 8 * 1024 * 1024
MIN_EXAM_CASES = 30
DIM = 512
FIELDS = {"v", "model", "catalog", "crop", "entries", "dim", "sha256", "url", "exam", "regression", "improved", "seq", "issuedAt"}
HEX16 = re.compile(r"[0-9a-f]{16}")
HEX64 = re.compile(r"[0-9a-f]{64}")


class Refused(Exception):
    pass


def _rate(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and 0 <= x <= 1


def _score_block(name, block, extra=()):
    if not isinstance(block, dict) or not {"before", "after", "n"} <= set(block) <= {"before", "after", "n", *extra}:
        raise Refused(f"{name} has the wrong fields")
    if not (_rate(block["before"]) and _rate(block["after"]) and isinstance(block["n"], int) and not isinstance(block["n"], bool) and block["n"] >= 0):
        raise Refused(f"{name} numbers are out of range")


def _check_pack(pack, entries):
    if len(pack) < 4:
        raise Refused("pack too short")
    (n,) = struct.unpack("<I", pack[:4])
    if n > MAX_HEADER or 4 + n > len(pack):
        raise Refused("pack header length is wrong")
    try:
        header = json.loads(pack[4 : 4 + n].decode("utf-8"))
    except ValueError as err:
        raise Refused("pack header is not JSON") from err
    ids = header.get("cardIds") if isinstance(header, dict) else None
    if not isinstance(ids, list) or header.get("v") != 1 or header.get("dim") != DIM or header.get("entries") != len(ids):
        raise Refused("pack header fields are wrong")
    if len(ids) != entries:
        raise Refused("pack entries differ from the manifest")
    if len(ids) > MAX_ENTRIES:
        raise Refused("too many entries")
    if not all(isinstance(i, str) and i and len(i) <= 64 for i in ids):
        raise Refused("pack has an empty or oversized card id")
    if len(pack) != 4 + n + len(ids) * DIM:
        raise Refused("pack size does not match its header")


def _parse_time(text):
    if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", text):
        raise Refused("issuedAt is not a UTC timestamp")
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)


def verify_release(manifest_bytes, pack_bytes, *, expected_url, run_number, now):
    """Returns the parsed manifest, or raises Refused."""
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except ValueError as err:
        raise Refused("manifest is not JSON") from err
    if not isinstance(manifest, dict) or set(manifest) != FIELDS:
        raise Refused("manifest fields are not the expected set")
    if manifest["v"] != 1 or manifest["dim"] != DIM or not isinstance(manifest["crop"], int):
        raise Refused("manifest v, dim or crop is wrong")
    for key in ("model", "catalog"):
        if not (isinstance(manifest[key], str) and HEX16.fullmatch(manifest[key])):
            raise Refused(f"manifest {key} is not 16 hex digits")
    if not (isinstance(manifest["sha256"], str) and HEX64.fullmatch(manifest["sha256"])) or hashlib.sha256(pack_bytes).hexdigest() != manifest["sha256"]:
        raise Refused("pack sha256 does not match the manifest")
    if manifest["url"] != expected_url:
        raise Refused("manifest url is not this run's release asset")
    if manifest["seq"] != run_number or isinstance(manifest["seq"], bool):
        raise Refused("manifest seq is not this run's number")
    if abs((_parse_time(manifest["issuedAt"]) - now).total_seconds()) > 3600:
        raise Refused("manifest issuedAt is not within an hour of now")
    if not isinstance(manifest["entries"], int) or isinstance(manifest["entries"], bool):
        raise Refused("manifest entries is not an integer")
    _check_pack(pack_bytes, manifest["entries"])

    exam, regression = manifest["exam"], manifest["regression"]
    _score_block("exam", exam, extra=("wrongAtHigh",))
    if regression is not None:
        _score_block("regression", regression)
    expected = bool(
        regression and regression["n"] > 0 and regression["after"] >= regression["before"]
        and exam["after"] > exam["before"] and exam["n"] >= MIN_EXAM_CASES
    )
    if manifest["improved"] is not expected:
        raise Refused("improved does not follow from the exam and regression numbers")
    return manifest


def sign(data, pem):
    """Base64 raw r||s ECDSA P-256 / SHA-256 signature."""
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise Refused("signing key must be ECDSA P-256")
    r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
    return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--run-number", type=int, required=True)
    ap.add_argument("--now", help="UTC time for tests, as 2026-10-15T03:30:00Z")
    args = ap.parse_args(argv)

    pem = os.environ.get("PACK_SIGNING_KEY", "")
    if not pem.strip():
        sys.exit("PACK_SIGNING_KEY is not set")
    with open(os.path.join(args.dir, "manifest.json"), "rb") as f:
        manifest_bytes = f.read()
    with open(os.path.join(args.dir, "community-pack.bin"), "rb") as f:
        pack_bytes = f.read()
    now = _parse_time(args.now) if args.now else datetime.datetime.now(datetime.timezone.utc)
    try:
        verify_release(manifest_bytes, pack_bytes, expected_url=args.url, run_number=args.run_number, now=now)
        signature = sign(manifest_bytes, pem)
    except Refused as err:
        sys.exit(f"refusing to sign: {err}")
    with open(os.path.join(args.dir, "manifest.sig"), "w", encoding="ascii") as f:
        f.write(signature)
    print("signed", file=sys.stderr)


if __name__ == "__main__":
    main()
