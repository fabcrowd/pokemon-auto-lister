"""Remote listing data cannot pick where a crop is written or what is fetched."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vellum_ai.variant_photos import image_url, listing_id  # noqa: E402


class RemoteInputTests(unittest.TestCase):
    def test_listing_id_is_digits_only(self) -> None:
        self.assertEqual(listing_id(270067229), "270067229")
        for bad in ("", "..\\crops", "12/34", "123?x=1", "1" * 13):
            with self.assertRaises(ValueError, msg=bad):
                listing_id(bad)

    def test_image_url_must_be_https_on_the_listing_host(self) -> None:
        url = image_url("https://shopgoodwillimages.azureedge.net/production/", "1\\2\\a.jpg")
        self.assertEqual(url, "https://shopgoodwillimages.azureedge.net/production/1/2/a.jpg")
        for server in ("", "file:///C:/", "http://shopgoodwillimages.azureedge.net/", "https://evil.example/"):
            with self.assertRaises(ValueError, msg=server):
                image_url(server, "a.jpg")


if __name__ == "__main__":
    unittest.main()
