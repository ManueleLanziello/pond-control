$projectRoot = Split-Path -Parent $PSScriptRoot
$venvPath = Join-Path $projectRoot '.venv-camera'
$coreSetup = Join-Path $projectRoot '..\smarthome-core\scripts\setup-camera.ps1'
& $coreSetup -VenvPath $venvPath -BootstrapPython $env:POND_CAMERA_BOOTSTRAP_PYTHON
