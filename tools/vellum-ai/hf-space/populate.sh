#!/usr/bin/env bash
# Run this from the repo root to copy server files into your HF Space repo.
# Usage:
#   bash tools/vellum-ai/hf-space/populate.sh /path/to/your-hf-space-repo

set -e

DEST="${1:?Usage: populate.sh <path-to-hf-space-repo>}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SERVER="$REPO_ROOT/tools/vellum-ai"
CATALOG="$REPO_ROOT/data/card-catalog"

echo "Copying server files to $DEST ..."

cp "$SERVER/server.py"  "$DEST/server.py"
cp "$SERVER/pricing.py" "$DEST/pricing.py"
cp -r "$SERVER/vellum_ai/" "$DEST/vellum_ai/"

mkdir -p "$DEST/models"
cp "$SERVER/models/card_detect.onnx" "$DEST/models/card_detect.onnx"

mkdir -p "$DEST/catalog"
cp "$CATALOG/embeddings.faiss" "$DEST/catalog/embeddings.faiss"
cp "$CATALOG/embeddings.npy"   "$DEST/catalog/embeddings.npy"
cp "$CATALOG/meta.json"        "$DEST/catalog/meta.json"
cp "$CATALOG/id_map.json"      "$DEST/catalog/id_map.json"
cp "$CATALOG/phash.json"       "$DEST/catalog/phash.json"

echo "Done. Now cd into $DEST and run:"
echo "  git lfs track 'catalog/*.faiss' 'catalog/*.npy'"
echo "  git add . && git commit -m 'deploy' && git push"
