"""Quick scan of cached hibid lots to find which have actual cards vs sealed boxes."""
import sys, os
sys.path.insert(0, 'tools/vellum-ai')
os.environ['VELLUM_AI_DETECT_ONNX'] = '/nonexistent/model.onnx'
from pathlib import Path
import cv2
from vellum_ai.pipeline import glare_score, blur_score
from vellum_ai.ocr import run_ocr
from vellum_ai.detect_multi import _contour_multi

cache = Path('tools/vellum-ai/tests/test_stress_detect.py').resolve().parents[3] / 'data' / 'detect-marketplace' / 'hibid'

# Scan all lots
all_lots = sorted(cache.iterdir())
print(f"Scanning {len(all_lots)} lots...\n")

for lot_path in all_lots:
    imgs = sorted(p for p in lot_path.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg'})
    if not imgs:
        continue
    numbers_found = []
    names_found = []
    for img_path in imgs:
        frame = cv2.imread(str(img_path))
        if frame is None:
            continue
        g = glare_score(frame)
        b = blur_score(frame)
        # Quick skip if clearly bad quality
        if g >= 0.35:
            continue
        cards = _contour_multi(frame)
        ocr = run_ocr(frame)
        num = ocr.get('number', '')
        name = ocr.get('name', '')
        if num:
            numbers_found.append(num)
        if name:
            names_found.append(name)
    status = 'CARDS' if numbers_found else 'BOXES'
    print(f"[{status}] {lot_path.name}: numbers={numbers_found[:3]} names={names_found[:3]}")
