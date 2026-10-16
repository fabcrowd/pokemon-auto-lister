import io
import unittest

import numpy as np
from PIL import Image

import _paths  # noqa: F401
from pipeline.embed import art_rect, preprocess


class ArtCrop(unittest.TestCase):
    def test_matches_lib_embed_js_art_source_rect(self):
        # 750x1050: strip = floor(1050 * 0.45) = 472, a centred 472-px square of that strip.
        self.assertEqual(art_rect(750, 1050), (139, 0, 472))
        # Narrow card: side limited by width, centred vertically inside the strip.
        self.assertEqual(art_rect(100, 400), (0, 40, 100))

    def test_tiny_images_keep_a_one_pixel_strip(self):
        x, y, side = art_rect(10, 1)
        self.assertEqual((y, side), (0, 1))
        self.assertGreaterEqual(x, 0)

    def test_preprocess_gives_a_normalised_chw_float_tensor(self):
        img = Image.new("RGB", (300, 420), (255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, "JPEG")
        x = preprocess(buf.getvalue())
        self.assertEqual(x.shape, (1, 3, 224, 224))
        self.assertEqual(x.dtype, np.float32)
        # white pixel, channel 0: (1 - 0.48145466) / 0.26862954
        self.assertAlmostEqual(float(x[0, 0, 0, 0]), (1 - 0.48145466) / 0.26862954, places=1)

    def test_only_the_top_strip_matters(self):
        top = Image.new("RGB", (300, 420), (10, 200, 30))
        a, b = io.BytesIO(), io.BytesIO()
        top.save(a, "PNG")
        bottom_changed = top.copy()
        bottom_changed.paste((250, 0, 0), (0, 200, 300, 420))  # below the 45% strip (189 px)
        bottom_changed.save(b, "PNG")
        np.testing.assert_array_equal(preprocess(a.getvalue()), preprocess(b.getvalue()))

    def test_undecodable_bytes_raise(self):
        with self.assertRaises(ValueError):
            preprocess(b"not an image")


if __name__ == "__main__":
    unittest.main()
