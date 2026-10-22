"""Keep the source's quality tier separate from the actual download height."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import downloader
from app.main import app


class VideoQualityTests(unittest.TestCase):
    def test_cropped_4k_keeps_nominal_tier_and_actual_resolution(self):
        info = downloader._normalize_info({"formats": [
            {"format_id": "401", "format_note": "2160p60", "ext": "mp4",
             "width": 3840, "height": 2026, "vcodec": "av01.0.13M.08", "acodec": "none"},
            {"format_id": "315", "format_note": "2160p60", "ext": "webm",
             "width": 3840, "height": 2026, "vcodec": "vp9", "acodec": "none"},
            {"format_id": "399", "format_note": "1080p60", "ext": "mp4",
             "width": 1920, "height": 1012, "vcodec": "av01.0.09M.08", "acodec": "none"},
        ]})
        self.assertEqual(info.qualities, [2026, 1012])
        self.assertEqual(info.formats[0].format_note, "2160p60")
        self.assertEqual(info.formats[0].resolution, "3840x2026")

        with patch("app.routes.downloader.extract_info", return_value=info):
            response = TestClient(app).post("/api/info", json={
                "url": "https://www.youtube.com/watch?v=-BHpOXZQUxo",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["qualities"], [2026, 1012])
        self.assertEqual(response.json()["formats"][0]["format_note"], "2160p60")

    def test_formats_without_nominal_tiers_remain_supported(self):
        info = downloader._normalize_info({"formats": [
            {"format_id": "video", "width": 1920, "height": 1080, "vcodec": "avc1"},
        ]})
        self.assertEqual(info.qualities, [1080])
        self.assertIsNone(info.formats[0].format_note)


if __name__ == "__main__":
    unittest.main()
