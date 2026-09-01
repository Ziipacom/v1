$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '.local/processes.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No script-started servers recorded.'; exit }
$processState = Get-Content -LiteralPath $statePath | ConvertFrom-Json
foreach ($entry in @($processState.api, $processState.web)) {
    $recordedProcess = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if ($recordedProcess -and $recordedProcess.StartTime.ToUniversalTime().ToString('o') -eq $entry.started) {
        taskkill.exe /PID $entry.id /T /F
    }
}
Remove-Item -LiteralPath $statePath
Write-Output 'Script-started servers stopped. Database services remain running; use docker compose stop to stop them.'
