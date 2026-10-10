# Builds the RoboDesk Windows installer. Run from the project folder:  powershell -ExecutionPolicy Bypass -File build-installer.ps1
# The build runs in the background; this script follows its log and opens the output folder when done.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
foreach ($t in 'node', 'npm', 'cargo') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $t (install Node.js 20+ and Rust with the MSVC toolchain; see README.md)" }
}
$log = Join-Path $PSScriptRoot 'build.log'
$job = Start-Job -ArgumentList $PSScriptRoot, $log -ScriptBlock {
  param($dir, $log)
  Set-Location $dir
  & cmd /c "npm install && npx tauri build" *> $log
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
}
Write-Host "Building in the background. Log: $log"
while ($job.State -eq 'Running') {
  Start-Sleep -Seconds 5
  if (Test-Path $log) { Write-Host ("  " + (Get-Content $log -Tail 1)) }
}
Receive-Job $job -ErrorAction SilentlyContinue | Out-Null
$out = Join-Path $PSScriptRoot 'target\release\bundle\nsis'
$exe = Get-ChildItem $out -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($job.State -eq 'Completed' -and $exe) { Write-Host "Installer: $($exe.FullName)"; Start-Process explorer.exe $out }
else { Write-Host "Build failed. See $log"; exit 1 }
