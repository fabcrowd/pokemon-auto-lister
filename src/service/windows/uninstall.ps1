#Requires -Version 5.1
<#
  Removes the Pokemon Auto-Lister scheduled task registered by install.ps1.
#>

$TaskName = "PokemonAutoLister"

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Existing) {
    Write-Host "No scheduled task named '$TaskName' found. Nothing to do."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed scheduled task '$TaskName'."
