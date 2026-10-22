"""Multi-connection video transfers, with native yt-dlp fallback.

aria2 handles HTTP byte ranges. Its loopback RPC supplies the same byte/speed
hooks as native yt-dlp, so the existing job progress and cancellation still work.
HLS/DASH fragments stay with yt-dlp's native concurrent downloader.
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener

from yt_dlp import YoutubeDL
from yt_dlp.downloader.external import Aria2cFD
from yt_dlp.utils import DownloadError, determine_protocol


class _ProgressAria2FD(Aria2cFD):
    EXE_NAME = "aria2c"

    def _call_downloader(self, tmpfilename, info_dict):
        # Each running transfer has a private RPC instance, reachable only on
        # loopback and authenticated with an independent random secret.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        secret = secrets.token_hex(24)
        connections = self.params.get("concurrent_fragment_downloads", 8)
        cmd = self._make_cmd(tmpfilename, info_dict)
        cmd[1:1] = [
            "--enable-rpc=true", "--rpc-listen-all=false",
            f"--rpc-listen-port={port}", f"--rpc-secret={secret}",
            f"--stop-with-process={os.getpid()}",
        ]
        # Append after aria2's built-in defaults, before its final URI.
        uri_index = cmd.index("--")
        cmd[uri_index:uri_index] = [
            f"--max-connection-per-server={connections}", f"--split={connections}",
            "--min-split-size=1M", "--max-tries=3", "--retry-wait=1",
            "--connect-timeout=15", "--timeout=30",
        ]
        opener = build_opener(ProxyHandler({}))

        def rpc(method, *params):
            request = Request(
                f"http://127.0.0.1:{port}/jsonrpc",
                data=json.dumps({
                    "jsonrpc": "2.0", "id": "progress", "method": f"aria2.{method}",
                    "params": [f"token:{secret}", *params],
                }).encode(),
                headers={"Content-Type": "application/json"},
            )
            with opener.open(request, timeout=0.5) as response:
                payload = json.load(response)
            if "error" in payload:
                raise OSError("aria2 progress unavailable")
            return payload["result"]

        fields = ["status", "errorCode", "completedLength", "totalLength", "downloadSpeed", "connections"]
        started = time.monotonic()
        last_rpc = started
        state = {"completedLength": "0", "totalLength": info_dict.get("filesize") or "0",
                 "downloadSpeed": "0"}
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            while process.poll() is None:
                try:
                    transfers = rpc("tellActive", fields) or rpc("tellStopped", 0, 1, fields)
                    last_rpc = time.monotonic()
                    if transfers:
                        state = transfers[0]
                except (OSError, ValueError):
                    # The RPC socket may not be ready on the first poll. Still
                    # emit a hook so a queued cancellation can stop startup.
                    if time.monotonic() - last_rpc > 10:
                        raise OSError("aria2 progress connection unavailable")
                total = int(state.get("totalLength") or 0) or info_dict.get("filesize")
                done = int(state.get("completedLength") or 0)
                speed = int(state.get("downloadSpeed") or 0)
                self._hook_progress({
                    "status": "downloading", "filename": tmpfilename,
                    "downloaded_bytes": done, "total_bytes": total,
                    "speed": speed, "eta": max(0, (total - done) / speed) if total and speed else None,
                    "elapsed": time.monotonic() - started,
                    "connections": int(state.get("connections") or 0),
                }, info_dict)
                # RPC-enabled aria2 stays alive after the queue finishes.
                if state.get("status") == "complete":
                    return 0
                if state.get("status") in {"error", "removed"}:
                    return int(state.get("errorCode") or 1)
                time.sleep(0.25)
            return process.returncode
        finally:
            # A progress hook can raise JobCancelled. Never leave the child
            # downloading after the job worker has returned.
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


class VideoYoutubeDL(YoutubeDL):
    def dl(self, name, info, subtitle=False, test=False):
        proxy = self.params.get("proxy") or ""
        use_aria2 = (
            not subtitle and not test and name != "-"
            and self.params.get("concurrent_fragment_downloads", 1) > 1
            and determine_protocol(info) in {"http", "https"}
            and not info.get("is_live") and not info.get("fragments")
            and info.get("section_start") is None and info.get("section_end") is None
            and not self.params.get("impersonate") and not info.get("impersonate")
            and (not proxy or urlparse(proxy).scheme in {"http", "https"})
            and shutil.which("aria2c") is not None
        )
        if not use_aria2:
            return super().dl(name, info, subtitle=subtitle, test=test)

        fd = _ProgressAria2FD(self, self.params)
        for hook in self._progress_hooks:
            fd.add_progress_hook(hook)
        prepared = self._copy_infodict(info)
        if prepared.get("http_headers") is None:
            prepared["http_headers"] = self._calc_headers(prepared)
        try:
            result = fd.download(name, prepared, subtitle)
            if result[0]:
                return result
        except (DownloadError, OSError):
            pass
        # aria2's sparse .part file cannot be resumed by the native sequential
        # downloader: its length is not the count of downloaded bytes.
        partial = fd.temp_name(name)
        for path in (partial, f"{partial}.aria2"):
            Path(path).unlink(missing_ok=True)
        self.report_warning("Multi-connection transfer failed; retrying with the native downloader.")
        return super().dl(name, info, subtitle=subtitle, test=test)
