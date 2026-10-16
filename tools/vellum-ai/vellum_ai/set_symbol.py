"""Set symbol on the line under the artwork, from a real photograph.

The mark names the expansion: Jungle's flower, Fossil's claw, Team Rocket's R.
Base Set has no mark there. The collector number and the edition stamps are
read elsewhere; this crop is only the symbol.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset

from vellum_ai.variant_photos import CROP_DIR, MANIFEST
from vellum_ai.variant_train import is_holdout

# Fractions of a rectified card. Tall enough for the Jungle flower, which sits
# lower than the Fossil claw, and still on the right of the species line.
SYMBOL_X1 = 0.70
SYMBOL_Y1 = 0.43
SYMBOL_X2 = 0.98
SYMBOL_Y2 = 0.55
INPUT_W = 96
INPUT_H = 48

CLASSES = ("base", "jungle", "fossil", "rocket")
ROOT = Path(__file__).resolve().parents[3]
WEIGHTS = ROOT / "data" / "variant-photos" / "set-symbol.pt"
REPORT = ROOT / "data" / "variant-photos" / "set-symbol-report.json"


def set_symbol_label(title: str) -> str | None:
    """The set named by a listing title, or None when the title does not say.

    Gym Heroes and Gym Challenge use different marks, so a title that only says
    gym is not one class. Base Set 2 has its own mark and is not Base Set.
    """
    text = title.lower()
    if "team rocket" in text:
        return "rocket"
    if "base set 2" in text:
        return None
    if "jungle" in text:
        return "jungle"
    if "fossil" in text:
        return "fossil"
    if "base set" in text or "shadowless" in text:
        return "base"
    return None


def symbol_box(width: int, height: int) -> tuple[int, int, int, int]:
    """Pixel box (x1, y1, x2, y2) of the set-symbol crop on a centered card."""
    return (
        int(SYMBOL_X1 * width),
        int(SYMBOL_Y1 * height),
        int(SYMBOL_X2 * width),
        int(SYMBOL_Y2 * height),
    )


def art_frame_bottom(gray: np.ndarray) -> int:
    """Row just under the picture, where the set symbol is printed.

    The search stops above the attack text. A lower line is a stronger edge
    on some photos and is not the frame.
    """
    height, width = gray.shape
    y0 = int(0.36 * height)
    y1 = int(0.54 * height)
    x0 = int(0.20 * width)
    x1 = int(0.80 * width)
    best_y = int(0.45 * height)
    best = 0.0
    for y in range(y0, max(y0 + 1, y1 - 4)):
        diff = float(np.abs(gray[y, x0:x1] - gray[y + 3, x0:x1]).mean())
        if diff > best:
            best = diff
            best_y = y
    return best_y


def symbol_rows() -> list[dict]:
    """One first photo per listing whose title names a trained set."""
    rows = []
    seen: set[str] = set()
    seen_pixels: set[str] = set()
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not str(row.get("file", "")).endswith("_00_0.jpg"):
            continue
        listing = str(row.get("listing") or "")
        if listing in seen:
            continue
        label = set_symbol_label(str(row.get("title") or ""))
        if label not in CLASSES:
            continue
        path = CROP_DIR / row["file"]
        if not path.is_file():
            continue
        # A relisted photo under a new id would otherwise sit in both splits.
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        if digest in seen_pixels:
            continue
        seen_pixels.add(digest)
        seen.add(listing)
        rows.append({**row, "label": label})
    return rows


def _crop_array(path: Path) -> np.ndarray:
    image = Image.open(path).convert("L")
    gray = np.asarray(image, dtype=np.float32)
    height, width = gray.shape
    y1 = art_frame_bottom(gray)
    y2 = min(height, y1 + int(0.08 * height))
    x1 = int(0.72 * width)
    x2 = int(0.97 * width)
    crop = image.crop((x1, y1, x2, y2)).resize((INPUT_W, INPUT_H), Image.BILINEAR)
    return np.asarray(crop, dtype=np.float32) / 255.0


class SymbolDataset(Dataset):
    """Grayscale set-symbol crops."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        row = self.rows[index]
        array = _crop_array(CROP_DIR / row["file"])
        tensor = torch.from_numpy(array).unsqueeze(0)
        return tensor, CLASSES.index(row["label"])


class SymbolNet(nn.Module):
    """Small net on the symbol crop. The rest of the card is not an input."""

    def __init__(self, classes: int = len(CLASSES)) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Flatten(),
            nn.Linear(32 * (INPUT_H // 4) * (INPUT_W // 4), classes),
        )

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return self.net(images)


def _report(model: SymbolNet, rows: list[dict]) -> dict:
    model.eval()
    counts = {name: {"support": 0, "correct": 0} for name in CLASSES}
    loader = DataLoader(SymbolDataset(rows), batch_size=32)
    with torch.no_grad():
        for images, target in loader:
            pred = model(images).argmax(dim=1)
            for i in range(images.shape[0]):
                name = CLASSES[int(target[i])]
                counts[name]["support"] += 1
                counts[name]["correct"] += int(int(pred[i]) == int(target[i]))
    # Totals only. A list of missed holdout cards invites fixing them one by one.
    return {"classes": counts}


def train(epochs: int = 25) -> dict:
    """Fit on real photos and write the holdout counts. Returns that report."""
    torch.manual_seed(0)
    rows = symbol_rows()
    train_rows = [row for row in rows if not is_holdout(row["listing"])]
    holdout_rows = [row for row in rows if is_holdout(row["listing"])]
    model = SymbolNet()
    counts = np.array([sum(row["label"] == name for row in train_rows) for name in CLASSES], dtype=np.float32)
    weight = torch.tensor(counts.sum() / np.maximum(counts, 1.0), dtype=torch.float32)
    weight = weight / weight.mean()
    loss_fn = nn.CrossEntropyLoss(weight=weight)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
    loader = DataLoader(SymbolDataset(train_rows), batch_size=16, shuffle=True)
    for _ in range(epochs):
        model.train()
        for images, target in loader:
            opt.zero_grad()
            loss = loss_fn(model(images), target)
            loss.backward()
            opt.step()
    report = _report(model, holdout_rows)
    report["train"] = len(train_rows)
    report["holdout"] = len(holdout_rows)
    WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), WEIGHTS)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report
