"""Worker on-demand per il live proprietario TP-Link Tapo C410.

Riceve le credenziali soltanto dall'ambiente, produce JPEG completi in modo
atomico e non modifica mai la configurazione della telecamera.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import imageio_ffmpeg
from pytapo import StreamType, Tapo


def emit(event: str, **values: object) -> None:
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def redact(message: object, secrets: tuple[str, ...]) -> str:
    safe = str(message)
    for secret in secrets:
        if secret:
            safe = safe.replace(secret, "[REDACTED]")
    return safe


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


class JpegCollector:
    def __init__(self, live_path: Path):
        self.live_path = live_path
        self.buffer = bytearray()
        self.latest: bytes | None = None
        self.frames = 0
        self.first_frame_at: float | None = None

    def feed(self, chunk: bytes) -> None:
        self.buffer.extend(chunk)
        while True:
            start = self.buffer.find(b"\xff\xd8")
            if start < 0:
                self.buffer.clear()
                return
            end = self.buffer.find(b"\xff\xd9", start + 2)
            if end < 0:
                if start:
                    del self.buffer[:start]
                return
            jpeg = bytes(self.buffer[start:end + 2])
            del self.buffer[:end + 2]
            if len(jpeg) < 1024:
                continue
            self.latest = jpeg
            self.frames += 1
            atomic_write(self.live_path, jpeg)
            if self.first_frame_at is None:
                self.first_frame_at = time.perf_counter()
                emit("ready")


def classify_error(error: Exception) -> str:
    message = str(error).lower()
    if isinstance(error, FileNotFoundError) or "ffmpeg" in message and ("not found" in message or "no such file" in message):
        return "FFMPEG_NOT_FOUND"
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)) or "timeout" in message or "timed out" in message:
        return "TIMEOUT"
    if "auth" in message or "login" in message or "credential" in message or "password" in message:
        return "CAMERA_AUTH_FAILED"
    return "STREAM_FAILED"


def create_camera(ip: str, username: str, password: str) -> Tapo:
    return Tapo(
        ip,
        username,
        password,
        cloudPassword=password,
        reuseSession=False,
        printDebugInformation=False,
        printWarnInformation=False,
        redactConfidentialInformation=True,
        controlPort=443,
        streamPort=8800,
    )


async def drain_stderr(process: asyncio.subprocess.Process) -> None:
    if process.stderr is None:
        return
    while await process.stderr.readline():
        pass


async def collect_jpegs(process: asyncio.subprocess.Process, collector: JpegCollector) -> None:
    if process.stdout is None:
        return
    while True:
        chunk = await process.stdout.read(64 * 1024)
        if not chunk:
            return
        collector.feed(chunk)


async def stream_camera(args: argparse.Namespace, camera: Tapo) -> dict[str, object]:
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    process = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-hide_banner", "-loglevel", "error",
        "-probesize", "32",
        "-analyzeduration", "0",
        "-f", "mpegts", "-i", "pipe:0",
        "-map", "0:v:0",
        "-vf", "fps=4",
        "-q:v", "4",
        "-flush_packets", "1",
        "-f", "image2pipe", "pipe:1",
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    collector = JpegCollector(args.output_dir / "live-frame.jpg")
    collector_task = asyncio.create_task(collect_jpegs(process, collector))
    stderr_task = asyncio.create_task(drain_stderr(process))
    session = camera.getMediaSession(StreamType.Stream)
    payload = json.dumps({
        "type": "request",
        "seq": 1,
        "params": {
            "preview": {
                "audio": ["default"],
                "channels": [0],
                "resolutions": ["HD"],
            },
            "method": "get",
        },
    })
    transport_buffer = bytearray()
    started_at = time.perf_counter()
    stop_reason = "requested"

    try:
        async with session:
            async for response in session.transceive(payload, no_data_timeout=15.0):
                if args.stop_file.exists():
                    break
                if time.perf_counter() - started_at >= args.timeout_seconds:
                    stop_reason = "safety-timeout"
                    break
                if response.mimetype != "video/mp2t" or not response.plaintext:
                    continue
                transport_buffer.extend(response.plaintext)
                while len(transport_buffer) >= 188 and transport_buffer[0] != 0x47:
                    position = transport_buffer.find(0x47, 1)
                    if position < 0:
                        transport_buffer.clear()
                        break
                    del transport_buffer[:position]
                complete = len(transport_buffer) - (len(transport_buffer) % 188)
                if complete and process.stdin and not process.stdin.is_closing():
                    process.stdin.write(transport_buffer[:complete])
                    del transport_buffer[:complete]
                    await asyncio.wait_for(process.stdin.drain(), timeout=5.0)
    finally:
        if process.stdin and not process.stdin.is_closing():
            process.stdin.close()
            await process.stdin.wait_closed()
        try:
            await asyncio.wait_for(process.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            process.terminate()
            await process.wait()
        await asyncio.gather(collector_task, stderr_task, return_exceptions=True)

    if collector.latest:
        atomic_write(args.output_dir / "last-frame.jpg", collector.latest)
        updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write(
            args.output_dir / "metadata.json",
            json.dumps({"updatedAt": updated_at, "frames": collector.frames}).encode("utf-8"),
        )
    return {"frames": collector.frames, "reason": stop_reason}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--stop-file", required=True, type=Path)
    parser.add_argument("--timeout-seconds", required=True, type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    username = os.environ.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD", "")
    if not username or not password:
        emit("error", message="Credenziali Tapo non configurate.")
        return 1
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.stop_file.unlink(missing_ok=True)
    try:
        camera = create_camera(args.ip, username, password)
        result = asyncio.run(stream_camera(args, camera))
        emit("stopped", **result)
        return 0
    except Exception as error:
        emit("error", code=classify_error(error), message=redact(error, (username, password)))
        return 1
    finally:
        args.stop_file.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
