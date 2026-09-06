"""CLIP + FAISS retrieval against the local card catalog."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

DEFAULT_CATALOG = Path(
    os.environ.get(
        "VELLUM_AI_CATALOG_DIR",
        Path(__file__).resolve().parents[3] / "data" / "card-catalog",
    )
)


class CatalogIndex:
    """Lazy-loaded embedding index. Safe when files are missing (returns [])."""

    def __init__(self, catalog_dir: Optional[Path] = None) -> None:
        self.catalog_dir = Path(catalog_dir or DEFAULT_CATALOG)
        self.meta: List[Dict[str, Any]] = []
        self.id_map: List[str] = []
        self.index = None
        self.model = None
        self.preprocess = None
        self._loaded = False

    def available(self) -> bool:
        return (self.catalog_dir / "meta.json").is_file() and (
            (self.catalog_dir / "embeddings.faiss").is_file()
            or (self.catalog_dir / "embeddings.npy").is_file()
        )

    def load(self) -> None:
        if self._loaded:
            return
        meta_path = self.catalog_dir / "meta.json"
        if not meta_path.is_file():
            self._loaded = True
            return
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        id_map_path = self.catalog_dir / "id_map.json"
        if id_map_path.is_file():
            self.id_map = json.loads(id_map_path.read_text(encoding="utf-8"))
        else:
            self.id_map = [str(row.get("id") or i) for i, row in enumerate(self.meta)]

        faiss_path = self.catalog_dir / "embeddings.faiss"
        npy_path = self.catalog_dir / "embeddings.npy"
        if faiss_path.is_file():
            try:
                import faiss  # type: ignore

                self.index = faiss.read_index(str(faiss_path))
            except Exception:
                self.index = None
        elif npy_path.is_file():
            self._vectors = np.load(npy_path).astype(np.float32)
        self._loaded = True

    def _ensure_model(self) -> bool:
        if self.model is not None:
            return True
        try:
            import open_clip  # type: ignore
            import torch  # type: ignore

            model_name = os.environ.get("VELLUM_AI_CLIP_MODEL", "ViT-B-32")
            pretrained = os.environ.get("VELLUM_AI_CLIP_PRETRAINED", "openai")
            self.model, _, self.preprocess = open_clip.create_model_and_transforms(
                model_name, pretrained=pretrained
            )
            self.model.eval()
            self._torch = torch
            return True
        except Exception:
            return False

    def embed_bgr(self, image_bgr: np.ndarray) -> Optional[np.ndarray]:
        if not self._ensure_model():
            return None
        from PIL import Image

        # Art-biased crop: upper 45% of card
        h = image_bgr.shape[0]
        art = image_bgr[: max(1, int(h * 0.45)), :, :]
        rgb = art[:, :, ::-1]
        pil = Image.fromarray(rgb)
        tensor = self.preprocess(pil).unsqueeze(0)
        with self._torch.no_grad():
            feat = self.model.encode_image(tensor)
            feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat.cpu().numpy().astype(np.float32)

    def search(self, image_bgr: np.ndarray, k: int = 20) -> List[Dict[str, Any]]:
        self.load()
        if not self.meta:
            return []
        query = self.embed_bgr(image_bgr)
        if query is None:
            return []

        if self.index is not None:
            import faiss  # type: ignore

            faiss.normalize_L2(query)
            scores, indices = self.index.search(query, min(k, len(self.meta)))
            hits = []
            for score, idx in zip(scores[0], indices[0]):
                if idx < 0 or idx >= len(self.meta):
                    continue
                row = dict(self.meta[idx])
                row["score"] = float(score)
                hits.append(row)
            return hits

        vectors = getattr(self, "_vectors", None)
        if vectors is None:
            return []
        q = query[0]
        q = q / (np.linalg.norm(q) + 1e-9)
        sims = vectors @ q
        top = np.argsort(-sims)[:k]
        return [{**self.meta[i], "score": float(sims[i])} for i in top]


_default_index: Optional[CatalogIndex] = None


def get_index() -> CatalogIndex:
    global _default_index
    if _default_index is None:
        _default_index = CatalogIndex()
    return _default_index
