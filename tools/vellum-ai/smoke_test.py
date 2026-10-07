"""Smoke test for the extension scanner pipeline.

Run from tools/vellum-ai:
  python smoke_test.py
"""

from __future__ import annotations

import sys
import pathlib
import base64
import struct
import zlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


def minimal_jpeg_bytes(width: int = 64, height: int = 64) -> bytes:
    """Create a minimal valid JPEG (solid grey) without PIL."""
    import io
    try:
        from PIL import Image
        img = Image.new("RGB", (width, height), color=(128, 128, 128))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        return buf.getvalue()
    except ImportError:
        pass
    # Fallback: 1x1 white JPEG (hardcoded minimal valid JPEG)
    return bytes([
        0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,
        0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,
        0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,0x07,0x09,0x09,0x08,0x0A,
        0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,0x13,0x0F,0x14,0x1D,
        0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,0x22,
        0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,
        0x1F,0x27,0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,
        0x00,0x0B,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,
        0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,0x01,0x01,0x01,0x01,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,0x05,0x06,
        0x07,0x08,0x09,0x0A,0x0B,0xFF,0xC4,0x00,0xB5,0x10,0x00,0x02,0x01,
        0x03,0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7D,
        0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,
        0x51,0x61,0x07,0x22,0x71,0x14,0x32,0x81,0x91,0xA1,0x08,0x23,0x42,
        0xB1,0xC1,0x15,0x52,0xD1,0xF0,0x24,0x33,0x62,0x72,0x82,0x09,0x0A,
        0x16,0x17,0x18,0x19,0x1A,0x25,0x26,0x27,0x28,0x29,0x2A,0x34,0x35,
        0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4A,
        0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,
        0x68,0x69,0x6A,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x83,0x84,
        0x85,0x86,0x87,0x88,0x89,0x8A,0x92,0x93,0x94,0x95,0x96,0x97,0x98,
        0x99,0x9A,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,0xB2,0xB3,
        0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,
        0xC8,0xC9,0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xE1,
        0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xF1,0xF2,0xF3,0xF4,
        0xF5,0xF6,0xF7,0xF8,0xF9,0xFA,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,
        0x00,0x3F,0x00,0xFB,0xD2,0x8A,0x28,0x03,0xFF,0xD9
    ])


def check(label: str, cond: bool, detail: str = "") -> bool:
    status = "PASS" if cond else "FAIL"
    msg = f"  [{status}] {label}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    return cond


def main() -> int:
    failures = 0

    print("\n=== 1. Import chain ===")
    try:
        from vellum_ai.identify_multi import identify_all_from_bytes, CardResult
        failures += not check("identify_multi imports", True)
    except Exception as e:
        failures += not check("identify_multi imports", False, str(e))
        print("  Cannot continue without identify_multi"); return 1

    try:
        from pricing import get_price
        failures += not check("pricing imports", True)
    except Exception as e:
        failures += not check("pricing imports", False, str(e))

    print("\n=== 2. CardResult.as_dict() contract ===")
    sample = CardResult(
        index=0,
        box=(10.0, 20.0, 300.0, 420.0),
        identity={"name": "Charizard", "set": "Base Set", "setCode": "BS", "number": "4", "imageUrl": ""},
        confidence="high",
        abstain=False,
        reason=None,
        source_image="",
        crop_b64="",
    )
    d = sample.as_dict()
    failures += not check("box is list", isinstance(d.get("box"), list), str(type(d.get("box"))))
    failures += not check("box has 4 elements", len(d.get("box", [])) == 4)
    failures += not check("identity is dict", isinstance(d.get("identity"), dict))
    failures += not check("confidence is str", isinstance(d.get("confidence"), str))
    failures += not check("abstain is bool", isinstance(d.get("abstain"), bool))

    print("\n=== 3. ONNX model presence ===")
    from vellum_ai.detect import DEFAULT_ONNX
    model_present = DEFAULT_ONNX.is_file()
    check("ONNX model present", model_present, str(DEFAULT_ONNX))
    if not model_present:
        print("  (contour fallback will be used — this is expected)")

    print("\n=== 4. identify_all_from_bytes on synthetic image ===")
    img_bytes = minimal_jpeg_bytes(320, 240)
    try:
        results = identify_all_from_bytes(img_bytes)
        failures += not check("returns list", isinstance(results, list))
        print(f"  detected {len(results)} card(s) in blank image (expected 0)")
        for r in results:
            failures += not check("result has box list", isinstance(r.box, tuple))
            failures += not check("result has abstain bool", isinstance(r.abstain, bool))
    except Exception as e:
        failures += not check("identify_all_from_bytes runs", False, str(e))

    print("\n=== 5. get_price() return shape ===")
    try:
        from pricing import get_price
        # Call with a dummy identity — will return {} since it can't find a real price
        price = get_price({"name": "Charizard", "set": "Base Set", "setCode": "BS", "number": "4"})
        failures += not check("get_price returns dict", isinstance(price, dict))
        if price:
            required_keys = {"market_price", "price_low", "price_high", "price_variant", "price_source"}
            missing = required_keys - set(price.keys())
            failures += not check("get_price has all required keys", not missing, f"missing: {missing}")
            failures += not check("market_price is float|None", isinstance(price.get("market_price"), (float, type(None))))
        else:
            print("  get_price returned {} (no network / cache miss — expected in test env)")
    except Exception as e:
        failures += not check("get_price runs", False, str(e))

    print("\n=== 6. CORS header check (server.py config) ===")
    try:
        import ast, pathlib as p
        src = p.Path("server.py").read_text()
        has_cors = "CORSMiddleware" in src and 'allow_origins=["*"]' in src
        failures += not check("server.py has CORS wildcard", has_cors)
        has_port = "7331" in src
        failures += not check("server.py listens on 7331", has_port)
    except Exception as e:
        failures += not check("server.py readable", False, str(e))

    print(f"\n{'='*40}")
    if failures:
        print(f"SMOKE TEST: {failures} failure(s)")
    else:
        print("SMOKE TEST: ALL PASS")
    return failures


if __name__ == "__main__":
    sys.exit(main())
