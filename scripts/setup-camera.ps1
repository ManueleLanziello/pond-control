$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $projectRoot '.venv-camera'
$python = if ($env:POND_CAMERA_BOOTSTRAP_PYTHON) {
  $env:POND_CAMERA_BOOTSTRAP_PYTHON
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  'python'
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  'py'
} else {
  throw 'Python 3.11+ non trovato. Impostare POND_CAMERA_BOOTSTRAP_PYTHON con il percorso di python.exe.'
}

if (-not (Test-Path -LiteralPath $venvPath)) {
  & $python -m venv $venvPath
}

$venvPython = Join-Path $venvPath 'Scripts\python.exe'
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $projectRoot 'requirements-camera.txt')
& $venvPython -c "import imageio_ffmpeg, pytapo; print('Ambiente C410 pronto - FFmpeg ' + imageio_ffmpeg.get_ffmpeg_version())"
