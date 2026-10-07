FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    torch==2.2.2+cpu torchvision==0.17.2+cpu \
    --index-url https://download.pytorch.org/whl/cpu

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

COPY vellum_ai/ ./vellum_ai/
COPY server.py   ./server.py
COPY pricing.py  ./pricing.py
COPY models/card_detect.onnx ./models/card_detect.onnx

RUN mkdir -p /app/catalog
COPY catalog/embeddings.faiss /app/catalog/embeddings.faiss
COPY catalog/embeddings.npy   /app/catalog/embeddings.npy
COPY catalog/meta.json        /app/catalog/meta.json
COPY catalog/id_map.json      /app/catalog/id_map.json
COPY catalog/phash.json       /app/catalog/phash.json

ENV VELLUM_AI_CATALOG_DIR=/app/catalog
ENV VELLUM_HARVEST_DIR=
ENV HOST=0.0.0.0
ENV PORT=7860

EXPOSE 7860

CMD ["python", "server.py"]
