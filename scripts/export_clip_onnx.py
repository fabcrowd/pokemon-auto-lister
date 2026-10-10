"""
Export OpenAI CLIP ViT-B-32 visual encoder to ONNX (fp32 then int8 quantized).

Requirements:
    pip install open_clip_torch torch onnxruntime onnx

Output:
    clip_visual_fp32.onnx   (~150 MB, intermediate)
    clip_visual_int8.onnx   (~38 MB, upload to GitHub Release)
"""

import os
import sys
import torch
import open_clip
from onnxruntime.quantization import quantize_dynamic, QuantType

# Force UTF-8 output so Unicode arrows don't crash on Windows cp1252 terminals
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class VisualEncoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.model.encode_image(x)
        return features / features.norm(dim=-1, keepdim=True)


def main():
    print("Loading CLIP ViT-B-32 (openai) …")
    model, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model.eval()

    encoder = VisualEncoder(model)
    dummy = torch.zeros(1, 3, 224, 224, dtype=torch.float32)

    fp32_path = "clip_visual_fp32.onnx"
    int8_path = "clip_visual_int8.onnx"

    print(f"Exporting fp32 → {fp32_path} …")
    torch.onnx.export(
        encoder,
        dummy,
        fp32_path,
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
        opset_version=14,
        dynamo=False,  # Legacy TorchScript exporter — ORT WASM compatible
    )

    print(f"Quantizing → {int8_path} …")
    quantize_dynamic(
        fp32_path,
        int8_path,
        weight_type=QuantType.QUInt8,
    )

    size_mb = os.path.getsize(int8_path) / 1_000_000
    print(f"Done. {int8_path} is {size_mb:.1f} MB — upload to GitHub Release v2.0")

    # Clean up large intermediate
    os.remove(fp32_path)
    print(f"Removed intermediate {fp32_path}")


if __name__ == "__main__":
    main()
