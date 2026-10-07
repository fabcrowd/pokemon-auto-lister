# Build from repo root:
#   docker build -f tools/vellum-ai/Dockerfile -t pokemon-scanner .
#
# Run locally:
#   docker run -p 7331:7331 pokemon-scanner
#
# On cloud (Railway/Render) set PORT env var; they pass it in automatically.

FROM python:3.11-slim

WORKDIR /app

# System deps for opencv + faiss
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only torch first (smaller wheel, avoids CUDA pull)
RUN pip install --no-cache-dir \
    torch==2.2.2+cpu torchvision==0.17.2+cpu \
    --index-url https://download.pytorch.org/whl/cpu

# Install all other Python deps (including the heavy ones commented out in requirements.txt)
COPY tools/vellum-ai/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir \
    fastapi>=0.115.0 \
    "uvicorn[standard]>=0.32.0" \
    python-multipart>=0.0.12 \
    numpy>=1.26.0 \
    Pillow>=10.0.0 \
    ImageHash>=4.3.1 \
    opencv-python-headless>=4.8.0 \
    rapidocr-onnxruntime>=1.2.0 \
    onnxruntime>=1.17.0 \
    "open-clip-torch>=2.24.0" \
    "faiss-cpu>=1.8.0"

# Application code
COPY tools/vellum-ai/vellum_ai/ ./vellum_ai/
COPY tools/vellum-ai/server.py   ./server.py
COPY tools/vellum-ai/pricing.py  ./pricing.py

# Detection model (~10 MB)
COPY tools/vellum-ai/models/card_detect.onnx ./models/card_detect.onnx

# Card catalog index files only — no images (saves ~1.8 GB)
RUN mkdir -p /app/catalog
COPY data/card-catalog/embeddings.faiss /app/catalog/embeddings.faiss
COPY data/card-catalog/embeddings.npy   /app/catalog/embeddings.npy
COPY data/card-catalog/meta.json        /app/catalog/meta.json
COPY data/card-catalog/id_map.json      /app/catalog/id_map.json
COPY data/card-catalog/phash.json       /app/catalog/phash.json

# Point the app at the catalog; disable harvest writes; bind to all interfaces
ENV VELLUM_AI_CATALOG_DIR=/app/catalog
ENV VELLUM_HARVEST_DIR=
ENV HOST=0.0.0.0
ENV PORT=7331

EXPOSE 7331

CMD ["python", "server.py"]
