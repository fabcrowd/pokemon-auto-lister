"""Train the variant classifier on real card photographs and export ONNX.

Every layer is updated. The pictures are the harvested ShopGoodwill crops.
A near-duplicate cluster of listings is entirely in one split, so a second
photo of the same physical card cannot leak across. The checkpoint is chosen on a validation slice of the
training listings; the holdout is scored once, after training ends.
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
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from vellum_ai.dhash import listing_clusters
from vellum_ai.variant_labels import EDITIONS, FINISHES, STAMPS
from vellum_ai.variant_photos import CROP_DIR, MANIFEST, relabel_manifest

ROOT = Path(__file__).resolve().parents[3]
ONNX_PATH = ROOT / "tools" / "extension-wasm" / "models" / "variant.onnx"
REPORT_PATH = ROOT / "data" / "variant-photos" / "holdout-report.json"
DHASH_CACHE = ROOT / "data" / "variant-photos" / "dhash-py-cache.json"
MIN_SUPPORT = 30
FULL = 224
ZOOM = 112
IMAGE_W = 224
IMAGE_H = FULL + ZOOM

# ImageNet normalization. The backbone may start from those weights; the card
# labels never come from a render or a scan.
_MEAN = (0.485, 0.456, 0.406)
_STD = (0.229, 0.224, 0.225)


def is_holdout(listing: str) -> bool:
    """About one listing in five. Stable across runs."""
    digest = hashlib.md5(listing.encode("utf-8")).hexdigest()
    return int(digest[:2], 16) < 51


def _is_validation(listing: str) -> bool:
    """About one training listing in six, from a different part of the hash."""
    digest = hashlib.md5(listing.encode("utf-8")).hexdigest()
    return int(digest[2:4], 16) < 43


def cluster_map(rows: list[dict]) -> dict[str, str]:
    """Listing -> id of its near-duplicate cluster, from the crops on disk."""
    return listing_clusters(rows, CROP_DIR, DHASH_CACHE)


def listing_splits(listings: set[str], clusters: dict[str, str]) -> dict[str, str]:
    """Split of each listing: its own hash, then lifted to its cluster's strongest.

    A cluster is holdout if any member is, else validation if any member is.
    Only listings that join a cluster move, and only toward holdout, so adding
    a listing never pulls an existing holdout listing out of the holdout.
    """
    own = {}
    for listing in listings:
        if is_holdout(listing):
            own[listing] = "holdout"
        elif _is_validation(listing):
            own[listing] = "val"
        else:
            own[listing] = "train"
    rank = {"train": 0, "val": 1, "holdout": 2}
    strongest: dict[str, str] = {}
    for listing, split in own.items():
        root = clusters.get(listing, listing)
        if rank[split] > rank.get(strongest.get(root, "train"), 0) or root not in strongest:
            strongest[root] = split
    return {listing: strongest[clusters.get(listing, listing)] for listing in listings}


def split_rows(
    rows: list[dict], clusters: dict[str, str] | None = None
) -> tuple[list[dict], list[dict], list[dict]]:
    """Train, validation, and holdout rows, split by near-duplicate cluster."""
    if clusters is None:
        clusters = cluster_map(rows)
    splits = listing_splits({row["listing"] for row in rows}, clusters)
    parts: dict[str, list[dict]] = {"train": [], "val": [], "holdout": []}
    for row in rows:
        parts[splits[row["listing"]]].append(row)
    return parts["train"], parts["val"], parts["holdout"]


def load_rows() -> list[dict]:
    """Manifest rows whose crop file is still on disk.

    The same photograph is often relisted. One copy is kept so identical
    pixels cannot sit in both the training set and the holdout.
    """
    rows = []
    seen_hash: set[str] = set()
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        path = CROP_DIR / row["file"]
        if not path.is_file():
            continue
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        if digest in seen_hash:
            continue
        seen_hash.add(digest)
        rows.append(row)
    return rows


def compose(image: Image.Image) -> Image.Image:
    """Full card, plus a larger view of the stamp and the right art-frame edge.

    The 1st Edition stamp and the Base Set drop shadow are a few dozen pixels
    on the card. A square resize of the whole card erases both.
    """
    canvas = Image.new("RGB", (IMAGE_W, IMAGE_H), (180, 170, 140))
    canvas.paste(image.resize((FULL, FULL), Image.BILINEAR), (0, 0))
    width, height = image.size
    stamp = image.crop((0, int(0.30 * height), int(0.38 * width), int(0.70 * height)))
    border = image.crop((int(0.68 * width), int(0.15 * height), width, int(0.45 * height)))
    canvas.paste(stamp.resize((ZOOM, ZOOM), Image.BILINEAR), (0, FULL))
    canvas.paste(border.resize((ZOOM, ZOOM), Image.BILINEAR), (ZOOM, FULL))
    return canvas


def _index(names: tuple[str, ...], value: str | None) -> int:
    if value not in names:
        return -1
    return names.index(value)


class CropDataset(Dataset):
    """One rectified card front and the heads the listing actually labeled."""

    def __init__(self, rows: list[dict], train: bool) -> None:
        self.rows = rows
        self.train = train

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        row = self.rows[index]
        image = Image.open(CROP_DIR / row["file"]).convert("RGB")
        if self.train:
            array = _augment(np.asarray(image, dtype=np.float32) / 255.0)
            image = Image.fromarray((array * 255).astype(np.uint8))
        array = np.asarray(compose(image), dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).permute(2, 0, 1)
        for channel, mean, std in zip(tensor, _MEAN, _STD):
            channel.sub_(mean).div_(std)
        targets = torch.tensor([
            _index(EDITIONS, row.get("edition")),
            _index(FINISHES, row.get("finish")),
            _index(STAMPS, row.get("stamp")),
        ], dtype=torch.long)
        return tensor, targets


def _augment(array: np.ndarray) -> np.ndarray:
    """Brightness, contrast, and a small rotation. No mirror: the stamp is on the left."""
    jitter = 0.85 + np.random.random() * 0.3
    array = np.clip(array * jitter, 0, 1)
    if np.random.random() < 0.5:
        array = np.clip((array - 0.5) * (0.8 + np.random.random() * 0.4) + 0.5, 0, 1)
    degrees = np.random.uniform(-8, 8)
    image = Image.fromarray((array * 255).astype(np.uint8)).rotate(degrees, resample=Image.BILINEAR, fillcolor=(180, 170, 140))
    return np.asarray(image, dtype=np.float32) / 255.0


class VariantNet(nn.Module):
    """Three heads on one photo backbone: edition, finish, promo stamp."""

    def __init__(self, pretrained: bool = True) -> None:
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        backbone = mobilenet_v3_small(weights=weights)
        features = backbone.classifier[0].in_features
        backbone.classifier = nn.Sequential(nn.Linear(features, 256), nn.Hardswish(), nn.Dropout(0.2))
        self.backbone = backbone
        self.edition = nn.Linear(256, len(EDITIONS))
        self.finish = nn.Linear(256, len(FINISHES))
        self.stamp = nn.Linear(256, len(STAMPS))

    def forward(self, images: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        shared = self.backbone(images)
        return self.edition(shared), self.finish(shared), self.stamp(shared)


def _balance(rows: list[dict], key: str) -> list[dict]:
    """Repeat scarce labels until each value of ``key`` appears about equally."""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        value = row.get(key)
        if value:
            groups.setdefault(value, []).append(row)
    if len(groups) < 2:
        return rows
    target = max(len(group) for group in groups.values())
    balanced = list(rows)
    for group in groups.values():
        need = target - len(group)
        for i in range(need):
            balanced.append(group[i % len(group)])
    return balanced


def _weights(rows: list[dict], key: str, names: tuple[str, ...]) -> torch.Tensor:
    counts = np.ones(len(names), dtype=np.float32)
    for row in rows:
        index = _index(names, row.get(key))
        if index >= 0:
            counts[index] += 1
    weight = counts.sum() / counts
    return torch.tensor(weight / weight.mean(), dtype=torch.float32)


def _accuracy(logits: torch.Tensor, target: torch.Tensor) -> tuple[int, int]:
    labeled = target >= 0
    if not labeled.any():
        return 0, 0
    pred = logits.argmax(dim=1)
    return int((pred[labeled] == target[labeled]).sum()), int(labeled.sum())


def class_entry(support: int, correct: int, predicted: int, min_support: int = MIN_SUPPORT) -> dict:
    """Counts for one class. Below ``min_support`` the rates are noise, so they are null."""
    if support < min_support:
        return {"support": support, "correct": correct, "recall": None, "precision": None, "tooFew": True}
    return {
        "support": support,
        "correct": correct,
        "recall": None if support == 0 else round(correct / support, 3),
        "precision": None if predicted == 0 else round(correct / predicted, 3),
    }


def too_few_classes(report: dict) -> list[str]:
    return [
        f"{head}/{name}"
        for head, body in report["heads"].items()
        for name, cls in body["classes"].items()
        if cls.get("tooFew")
    ]


def holdout_report(
    model: VariantNet, rows: list[dict], device: torch.device, min_support: int = MIN_SUPPORT
) -> dict:
    """Per-class counts on listings the training loop never saw."""
    model.eval()
    names = (EDITIONS, FINISHES, STAMPS)
    keys = ("edition", "finish", "stamp")
    confusion = [np.zeros((len(group), len(group)), dtype=np.int64) for group in names]
    loader = DataLoader(CropDataset(rows, train=False), batch_size=32)
    with torch.no_grad():
        for images, targets in loader:
            outputs = model(images.to(device))
            for head_index, (head, matrix) in enumerate(zip(outputs, confusion)):
                pred = head.argmax(dim=1).cpu()
                gold = targets[:, head_index]
                keep = gold >= 0
                for g, p in zip(gold[keep].tolist(), pred[keep].tolist()):
                    matrix[g, p] += 1
    report: dict = {"crops": len(rows), "heads": {}}
    for key, group, matrix in zip(keys, names, confusion):
        classes = {}
        for index, name in enumerate(group):
            support = int(matrix[index].sum())
            correct = int(matrix[index, index])
            predicted = int(matrix[:, index].sum())
            classes[name] = class_entry(support, correct, predicted, min_support)
        labeled = int(matrix.sum())
        report["heads"][key] = {
            "accuracy": None if labeled == 0 else round(float(matrix.trace()) / labeled, 3),
            "classes": classes,
        }
    return report


def train(epochs: int = 30, patience: int = 6) -> dict:
    """Fine-tune every layer and write the holdout report plus the ONNX file."""
    torch.manual_seed(0)
    relabel_manifest()
    rows = load_rows()
    train_rows, val_rows, holdout_rows = split_rows(rows)
    if len(train_rows) < 20 or not val_rows or not holdout_rows:
        raise SystemExit(
            f"need more labeled photos: train {len(train_rows)} val {len(val_rows)} holdout {len(holdout_rows)}"
        )
    device = torch.device("cpu")
    model = VariantNet(pretrained=True).to(device)
    balanced = _balance(train_rows, "edition")
    losses = [
        nn.CrossEntropyLoss(weight=_weights(balanced, key, names).to(device), ignore_index=-1)
        for key, names in (("edition", EDITIONS), ("finish", FINISHES), ("stamp", STAMPS))
    ]
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    loader = DataLoader(CropDataset(balanced, train=True), batch_size=32, shuffle=True)
    best_state = None
    best_score = -1.0
    stale = 0
    for epoch in range(epochs):
        model.train()
        total = 0.0
        for images, targets in loader:
            images, targets = images.to(device), targets.to(device)
            optimizer.zero_grad()
            outputs = model(images)
            loss = sum(fn(head, targets[:, i]) for i, (fn, head) in enumerate(zip(losses, outputs)))
            loss.backward()
            optimizer.step()
            total += float(loss.detach())
        report = holdout_report(model, val_rows, device, min_support=0)
        recalls = [
            cls["recall"]
            for head in report["heads"].values()
            for cls in head["classes"].values()
            if cls["support"] > 0 and cls["recall"] is not None
        ]
        score = sum(recalls) / len(recalls) if recalls else 0.0
        print(f"epoch {epoch + 1} loss {total / max(len(loader), 1):.3f} val {score:.3f}")
        if score > best_score + 1e-4:
            best_score = score
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    report = holdout_report(model, holdout_rows, device)
    report["trainCrops"] = len(train_rows)
    report["valCrops"] = len(val_rows)
    report["holdoutCrops"] = len(holdout_rows)
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    model.eval()
    torch.save(model.state_dict(), REPORT_PATH.with_name("variant.pt"))
    ONNX_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        torch.zeros(1, 3, IMAGE_H, IMAGE_W),
        str(ONNX_PATH),
        input_names=["image"],
        output_names=["edition", "finish", "stamp"],
        opset_version=17,
        dynamo=False,
    )
    print("wrote", ONNX_PATH)
    small = too_few_classes(report)
    if small:
        print(f"support under {MIN_SUPPORT}, rates withheld: {', '.join(small)}")
    print(json.dumps(report, indent=2))
    return report
