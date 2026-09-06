# Register a weekly Task Scheduler job to refresh the VellumAI card catalog.
# Run from an elevated PowerShell if your policy requires it.

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Python = Join-Path $ProjectRoot "tools\vellum-ai\.venv\Scripts\python.exe"
$Script = Join-Path $ProjectRoot "tools\vellum-ai\catalog\refresh_weekly.py"
$TaskName = "PokemonAutoLister-VellumAiCatalogRefresh"

if (-not (Test-Path $Python)) {
  Write-Host "Create the venv first:"
  Write-Host "  cd `"$ProjectRoot\tools\vellum-ai`""
  Write-Host "  python -m venv .venv"
  Write-Host "  .\.venv\Scripts\pip install -r requirements.txt"
  exit 1
}

$Action = New-ScheduledTaskAction -Execute $Python -Argument "`"$Script`"" -WorkingDirectory (Join-Path $ProjectRoot "tools\vellum-ai")
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Registered scheduled task: $TaskName"
