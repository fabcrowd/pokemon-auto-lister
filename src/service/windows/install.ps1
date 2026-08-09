#Requires -Version 5.1
<#
  Registers a Windows Task Scheduler task that starts the Pokemon Auto-Lister
  dashboard at logon and keeps it running across reboots.
#>

$TaskName = "PokemonAutoLister"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$EntryPoint = Join-Path $ProjectRoot "src\index.js"

if ($ProjectRoot -match "\\Desktop\\") {
    Write-Warning "Project path '$ProjectRoot' looks like it lives on the Desktop. Desktop items can be moved, synced (OneDrive), or deleted, which will break the scheduled task's absolute paths. Consider relocating the project before installing."
}

$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    throw "node.exe not found on PATH. Install Node.js (>=20) before running install.ps1."
}

$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$EntryPoint`"" -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' to run '$EntryPoint' at logon (restarts on failure, up to 3 times)."
Write-Host "Remember to allow inbound connections to PORT through Windows Firewall so phones on the LAN can reach the dashboard."
