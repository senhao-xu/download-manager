"""Covers and actual selected resolution must survive jobs and history."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from app import jobs, thumbnails
from app.main import app


def video_info(video_id, height=2026):
    return {
        "title": video_id,
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg",
        "width": 1920, "height": 1080, "fps": 30,
        "formats": [{"width": 7680, "height": 4320}],
        "requested_formats": [
            {"format_id": "audio", "vcodec": "none"},
            {"format_id": "video", "width": 3840 if height == 2026 else 1920,
             "height": height, "fps": 59.94},
        ],
    }


class VideoDetailsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_live_snapshot_sse_and_persisted_history_use_the_selected_stream(self):
        job = jobs.Job(id="cover-job", kind="youtube")
        snapshots = []

        def download(url, quality, directory, hook, site):
            info = video_info("-BHpOXZQUxo")
            hook({"status": "metadata", "info_dict": info})
            snapshots.append(jobs.snapshot(job))
            output = directory / "video.mp4"
            output.write_bytes(b"video")
            return info, [output]

        with patch("app.jobs.storage.job_dir", return_value=self.directory):
            with patch("app.jobs.downloader.download_sync", side_effect=download):
                with patch("app.jobs.history.append") as append:
                    jobs._run_single(job, "https://youtu.be/-BHpOXZQUxo", "best")
        self.assertEqual(job.status, "done")
        self.assertEqual(snapshots[0].resolution, "3840x2026")
        self.assertEqual(snapshots[0].fps, 59.94)
        self.assertTrue(snapshots[0].thumbnail.startswith("/api/thumbnail?"))
        record = append.call_args.args[0]
        self.assertEqual(record["resolution"], "3840x2026")
        self.assertEqual(record["thumbnail"], snapshots[0].thumbnail)

        with patch.dict(jobs._jobs, {job.id: job}, clear=True):
            events = TestClient(app).get(f"/api/jobs/{job.id}/events").text
        self.assertIn('"resolution":"3840x2026"', events.replace(" ", ""))
        with patch("app.routes.history.list_page", return_value=([record], 1)):
            response = TestClient(app).get("/api/history?kind=youtube").json()
        self.assertEqual(response["items"][0]["resolution"], "3840x2026")
        self.assertEqual(response["items"][0]["thumbnail"], snapshots[0].thumbnail)

    def test_batch_records_keep_each_videos_own_cover_and_resolution(self):
        sources = ["https://youtu.be/-BHpOXZQUxo", "https://youtu.be/JDnC-M2Bq48"]

        def download(url, quality, directory, hook, site):
            index = sources.index(url)
            info = video_info(url.rsplit("/", 1)[-1], 1080 if index == 0 else 2026)
            hook({"status": "metadata", "info_dict": info})
            output = directory / f"{index}.mp4"
            output.write_bytes(b"video")
            return info, [output]

        job = jobs.Job(id="batch-cover", kind="youtube")
        with patch("app.jobs.storage.job_dir", return_value=self.directory):
            with patch("app.jobs.downloader.download_sync", side_effect=download):
                with patch("app.jobs.history.append") as append:
                    jobs._run_batch(job, sources, "best", False)
        records = [call.args[0] for call in append.call_args_list]
        self.assertEqual(job.status, "done")
        self.assertEqual([rec["source"] for rec in records], sources)
        self.assertEqual([rec["resolution"] for rec in records], ["1920x1080", "3840x2026"])
        self.assertNotEqual(records[0]["thumbnail"], records[1]["thumbnail"])
        self.assertEqual([rec["title"] for rec in records], ["-BHpOXZQUxo", "JDnC-M2Bq48"])

    def test_old_youtube_records_gain_covers_without_extraction_or_migration(self):
        record = {"id": "old", "kind": "youtube", "created": 1,
                  "source": "https://www.youtube.com/watch?v=-BHpOXZQUxo"}
        with patch("app.routes.history.list_page", return_value=([record], 1)):
            with patch("app.routes.downloader.extract_info") as extract:
                response = TestClient(app).get("/api/history").json()
        item = response["items"][0]
        cover = parse_qs(urlparse(item["thumbnail"]).query)["url"][0]
        self.assertEqual(cover, "https://i.ytimg.com/vi/-BHpOXZQUxo/mqdefault.jpg")
        self.assertIsNone(item["resolution"])
        self.assertFalse(item["available"])
        extract.assert_not_called()
        self.assertNotIn("thumbnail", record)

    def test_saved_bilibili_covers_are_proxied_and_nonvideo_records_remain_plain(self):
        records = [
            {"id": "bili", "kind": "bilibili", "created": 1,
             "thumbnail": "http://i0.hdslb.com/bfs/cover.jpg", "resolution": "1920x1080", "fps": 30},
            {"id": "file", "kind": "http", "created": 1, "source": "https://example.com/file.zip"},
        ]
        with patch("app.routes.history.list_page", return_value=(records, 2)):
            items = TestClient(app).get("/api/history").json()["items"]
        self.assertIn("/api/thumbnail?", items[0]["thumbnail"])
        self.assertEqual(items[0]["resolution"], "1920x1080")
        self.assertIsNone(items[1]["thumbnail"])
        self.assertEqual(items[1]["thumbnail_candidates"], [])

    def test_audio_only_metadata_has_no_video_resolution(self):
        info = video_info("-BHpOXZQUxo")
        info["requested_formats"] = [{"format_id": "audio", "vcodec": "none"}]
        details = jobs._video_metadata(info)
        self.assertIsNone(details["resolution"])
        self.assertIsNone(details["fps"])

    def test_legacy_cover_lookup_accepts_youtube_url_variants_only(self):
        for url in ["https://youtu.be/-BHpOXZQUxo?t=1",
                    "https://www.youtube.com/shorts/-BHpOXZQUxo",
                    "https://www.youtube.com/embed/-BHpOXZQUxo",
                    "https://m.youtube.com/watch?v=-BHpOXZQUxo"]:
            with self.subTest(url=url):
                self.assertEqual(len(thumbnails.source_candidates(url)), 2)
        for url in [None, "https://youtube.com.evil.test/watch?v=-BHpOXZQUxo",
                    "https://www.youtube.com/watch?v=invalid", "file:///watch?v=-BHpOXZQUxo"]:
            self.assertEqual(thumbnails.source_candidates(url), [])


if __name__ == "__main__":
    unittest.main()
