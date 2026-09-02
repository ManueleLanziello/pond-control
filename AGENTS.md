# Pond-Control

## Architecture

- Node.js project. Development happens here; production updates through Git on branch `master`.
- Production runs on the SmartHome Windows machine in `C:\pond-control`.
- `hardware.json` is machine-specific runtime state, not source code.
- `config/device-roles.json` is authoritative for logical role assignments.
- `supported-device-catalog.js` is authoritative for supported hardware models.
- `devices.js` is legacy/bootstrap/test compatibility, not production runtime authority.

## Runtime model

Physical hardware and logical roles are separate. Resolve runtime devices only through:

`hardware registry -> supported model -> verification/runtime eligibility -> logical role -> dashboard/control`

Never resolve operational hardware from historical IDs, fixed IPs, model names, or old singleton instances.

Current roles:

- plug: `pump`, `heater`
- sensor: `pond_temperature`
- camera: `pond_camera`

## Supported hardware

- Plugs: TP-Link Tapo P105; TP-Link Tapo P100M; TPAP/SPAKE2+.
- Sensor: Dewin T & H Sensor with external probe via Tuya Cloud; physical identity is `tuyaDeviceId`.
- Camera: TP-Link Tapo C410 via PyTapo HTTPS; PyTapo/ffmpeg media runtime.

Do not add unsupported models without explicit integration and tests.

## Secrets

Secrets remain in `.env`. Never persist credentials or secrets in `hardware.json`, including `TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET`, `TAPO_USERNAME`, and `TAPO_PASSWORD`. `TUYA_DEVICE_ID`/`tuyaDeviceId` is device identity, not a secret. Never print secrets in diagnostics or test reports.

## Hardware safety

Default development/test mode is **NO REAL HARDWARE CONTACT**. Unless explicitly requested, do not switch plugs, verify real Tapo/Tuya devices, connect to cameras, start livestreams, or probe physical-device networks. Read-only real-hardware operations also require an explicit request. Prefer fixtures, mocks, and temporary directories.

## Replacement semantics

Technical changes to model, IP, MAC, or `tuyaDeviceId` must invalidate the previous runtime immediately. Preserve the logical role when appropriate, but keep the device unavailable until verification succeeds. Never fall back to old physical hardware. Alias-only changes must not recreate runtime.

## Migration rules

Migrations must be backward compatible with real persisted formats, recoverable after interrupted/failed startup, idempotent, role-preserving, and secret-safe. Do not destroy existing role-store assignments while importing legacy roles. Persist a new registry version only after required migration state is coherent.

## Files to leave alone

Unless explicitly requested, leave `data/`, `scripts/export-dewin-history.js`, and SmartHome-only deployment files untouched and do not add them to commits.

## Standard workflow

Before editing, read this file, run `git status --short`, and inspect only relevant files with targeted searches/ranges. Avoid broad audits and repeated reads.

During editing, make the smallest coherent change, reuse existing abstractions, avoid unrelated refactors, and ignore unrelated untracked files.

Use targeted tests while developing. Final validation:

```text
npm test
git diff --check
git status --short
```

Run the full test suite once before requesting approval, not repeatedly during exploration.

## Git

Never commit or push unless explicitly requested. When authorized, use selective `git add`, exclude runtime/untracked data, and report the commit hash and push result.

## Response style

Keep normal fix reports concise: root cause, files changed, tests, diff check, and required user action. Do not restate unchanged architecture.

## Efficiency

Trust documented stable architecture unless current code contradicts it. Keep file reads and searches focused, avoid repeated status/test commands, do not investigate unrelated untracked files, and stop when the requested task is complete.
