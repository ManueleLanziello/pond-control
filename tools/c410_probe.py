"""Probe isolato e read-only per TP-Link Tapo C410.

Usa esclusivamente TAPO_USERNAME e TAPO_PASSWORD dal file .env del progetto.
Non modifica configurazioni e non stampa credenziali o payload completi.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from pytapo import Tapo


CAMERA_IP = os.environ.get("TAPO_CAMERA_IP", "192.168.1.11")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
SAFE_INFO_KEYS = {
    "alias",
    "avatar",
    "basic_info",
    "device_info",
    "device_model",
    "device_name",
    "device_type",
    "fw_cur",
    "fw_ver",
    "hw_ver",
    "mac",
    "mac_address",
    "model",
    "name",
    "sw_ver",
    "type",
}


def load_tapo_credentials() -> tuple[str, str]:
    values: dict[str, str] = {}
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in {"TAPO_USERNAME", "TAPO_PASSWORD"}:
                values[key] = value.strip().strip("\"'")

    username = os.environ.get("TAPO_USERNAME") or values.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD") or values.get("TAPO_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("TAPO_USERNAME e TAPO_PASSWORD non disponibili.")
    return username, password


def redact(message: object, secrets: tuple[str, ...]) -> str:
    safe = str(message)
    for secret in secrets:
        if secret:
            safe = safe.replace(secret, "[REDACTED]")
    return safe


def safe_device_info(value: object) -> object:
    if isinstance(value, dict):
        return {
            str(key): safe_device_info(child)
            for key, child in value.items()
            if str(key).lower() in SAFE_INFO_KEYS
        }
    if isinstance(value, list):
        return [safe_device_info(child) for child in value]
    return value


def main() -> int:
    username, password = load_tapo_credentials()
    started = time.perf_counter()
    try:
        camera = Tapo(
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
        elapsed = time.perf_counter() - started
        report = {
            "connection": True,
            "authentication": True,
            "elapsed_seconds": round(elapsed, 3),
            "transport": "KLAP" if camera.isKLAP else "PyTapo HTTPS",
            "device_type": camera.deviceType,
            "stream_endpoint": f"{CAMERA_IP}:8800",
            "device_info": safe_device_info(camera.basicInfo),
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        elapsed = time.perf_counter() - started
        print(json.dumps({
            "connection": True,
            "authentication": False,
            "elapsed_seconds": round(elapsed, 3),
            "error_type": type(error).__name__,
            "error": redact(error, (username, password)),
        }, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
