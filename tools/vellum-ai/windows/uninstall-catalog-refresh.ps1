$TaskName = "PokemonAutoLister-VellumAiCatalogRefresh"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task (if present): $TaskName"
