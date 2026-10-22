"""Deployments must not reuse an old frontend entry document without checking."""
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount

from app.main import _FrontendFiles


class FrontendCacheTests(unittest.TestCase):
    def test_root_and_explicit_index_revalidate_even_for_not_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text('<script src="/assets/old.js"></script>')
            client = TestClient(Starlette(routes=[Mount("/", _FrontendFiles(directory=root, html=True))]))
            for url in ("/", "/index.html"):
                with self.subTest(url=url):
                    first = client.get(url)
                    self.assertEqual(first.status_code, 200)
                    self.assertEqual(first.headers["cache-control"], "no-cache")
                    cached = client.get(url, headers={"If-None-Match": first.headers["etag"]})
                    self.assertEqual(cached.status_code, 304)
                    self.assertEqual(cached.headers["cache-control"], "no-cache")
            (root / "index.html").write_text('<script src="/assets/new-build.js"></script>')
            updated = client.get("/", headers={"If-None-Match": first.headers["etag"]})
            self.assertEqual(updated.status_code, 200)
            self.assertIn("new-build.js", updated.text)
            self.assertEqual(updated.headers["cache-control"], "no-cache")

    def test_static_assets_are_unaffected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "asset.js").write_text("console.log('asset')")
            client = TestClient(Starlette(routes=[Mount("/", _FrontendFiles(directory=root, html=True))]))
            response = client.get("/asset.js")
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("cache-control", response.headers)


if __name__ == "__main__":
    unittest.main()
