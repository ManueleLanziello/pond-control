"""Acquisizione on-demand, limitata e read-only dalla Tapo C410.

Lo script usa il protocollo multimediale proprietario TCP/8800 tramite PyTapo.
Le sessioni vengono sempre chiuse; non modifica impostazioni della telecamera.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import time
from pathlib import Path

import imageio_ffmpeg
from pytapo import StreamType, Tapo

from c410_probe import CAMERA_IP, load_tapo_credentials, redact


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = PROJECT_ROOT / "test-output" / "c410"


def create_camera() -> Tapo:
    username, password = load_tapo_credentials()
    return Tapo(
        CAMERA_IP,
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


async def capture_transport_stream(camera: Tapo, destination: Path, seconds: float) -> dict:
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
    buffer = bytearray()
    received_bytes = 0
    requested_at = time.perf_counter()
    first_video_at: float | None = None

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        async with session:
            async for response in session.transceive(payload, no_data_timeout=15.0):
                if response.mimetype != "video/mp2t" or not response.plaintext:
                    continue
                if first_video_at is None:
                    first_video_at = time.perf_counter()
                buffer.extend(response.plaintext)

                while len(buffer) >= 188 and buffer[0] != 0x47:
                    sync_position = buffer.find(0x47, 1)
                    if sync_position < 0:
                        buffer.clear()
                        break
                    del buffer[:sync_position]

                complete_length = len(buffer) - (len(buffer) % 188)
                if complete_length:
                    output.write(buffer[:complete_length])
                    received_bytes += complete_length
                    del buffer[:complete_length]

                if time.perf_counter() - first_video_at >= seconds:
                    break

    finished_at = time.perf_counter()
    return {
        "bytes": received_bytes,
        "wake_seconds": None if first_video_at is None else round(first_video_at - requested_at, 3),
        "stream_seconds": None if first_video_at is None else round(finished_at - first_video_at, 3),
        "total_seconds": round(finished_at - requested_at, 3),
    }


def run_ffmpeg(arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", *arguments],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        index += 2
        if marker in {0xD8, 0xD9}:
            continue
        if index + 2 > len(data):
            break
        length = int.from_bytes(data[index:index + 2], "big")
        if marker in range(0xC0, 0xC4) and index + 7 <= len(data):
            height = int.from_bytes(data[index + 3:index + 5], "big")
            width = int.from_bytes(data[index + 5:index + 7], "big")
            return width, height
        index += length
    return None


def extract_frame(source: Path, destination: Path, last: bool = False) -> dict:
    destination.unlink(missing_ok=True)
    frame_filter = ["-vf", "select=gte(t\\,9.5)"] if last else []
    result = run_ffmpeg([
        "-i", str(source),
        "-map", "0:v:0",
        *frame_filter,
        "-frames:v", "1",
        "-q:v", "2",
        "-y", str(destination),
    ])
    data = destination.read_bytes() if destination.exists() else b""
    dimensions = jpeg_dimensions(data)
    return {
        "ok": result.returncode == 0 and dimensions is not None,
        "bytes": len(data),
        "resolution": None if dimensions is None else f"{dimensions[0]}x{dimensions[1]}",
        "ffmpeg_error": "" if result.returncode == 0 else result.stderr.decode("utf-8", "replace")[-500:],
    }


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("snapshot", "live"))
    args = parser.parse_args()
    username, password = load_tapo_credentials()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        authenticated_at = time.perf_counter()
        camera = await asyncio.to_thread(create_camera)
        authentication_seconds = time.perf_counter() - authenticated_at

        if args.mode == "snapshot":
            stream_path = OUTPUT_DIR / "snapshot-source.ts"
            jpeg_path = OUTPUT_DIR / "c410-snapshot.jpg"
            capture = await asyncio.wait_for(
                capture_transport_stream(camera, stream_path, 2.0), timeout=20.0
            )
            frame_started = time.perf_counter()
            frame = extract_frame(stream_path, jpeg_path)
            frame["decode_seconds"] = round(time.perf_counter() - frame_started, 3)
            stream_path.unlink(missing_ok=True)
            report = {
                "mode": "snapshot",
                "authentication_seconds": round(authentication_seconds, 3),
                "capture": capture,
                "frame": frame,
                "output": str(jpeg_path.relative_to(PROJECT_ROOT)) if frame["ok"] else None,
            }
        else:
            stream_path = OUTPUT_DIR / "c410-live-10s.ts"
            last_frame_path = OUTPUT_DIR / "c410-live-last-frame.jpg"
            capture = await asyncio.wait_for(
                capture_transport_stream(camera, stream_path, 10.0), timeout=30.0
            )
            frame = extract_frame(stream_path, last_frame_path, last=True)
            report = {
                "mode": "live",
                "authentication_seconds": round(authentication_seconds, 3),
                "capture": capture,
                "stream_file": str(stream_path.relative_to(PROJECT_ROOT)),
                "stream_file_bytes": stream_path.stat().st_size,
                "last_frame": frame,
                "last_frame_output": str(last_frame_path.relative_to(PROJECT_ROOT)) if frame["ok"] else None,
            }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if capture["bytes"] > 0 else 1
    except Exception as error:
        print(json.dumps({
            "mode": args.mode,
            "ok": False,
            "error_type": type(error).__name__,
            "error": redact(error, (username, password)),
        }, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
