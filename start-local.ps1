$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$logRoot = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
foreach ($port in @(8018, 5178)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use. Stop the existing Ziipa server first."
    }
}
Push-Location $projectRoot
try {
    docker compose up -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker services failed to start.' }
    $apiProcess = Start-Process -FilePath (Join-Path $projectRoot 'backend/.venv/Scripts/python.exe') -ArgumentList '-m uvicorn app:app --host 127.0.0.1 --port 8018' -WorkingDirectory (Join-Path $projectRoot 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'api.log') -RedirectStandardError (Join-Path $logRoot 'api-error.log')
    $webProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm.cmd run dev' -WorkingDirectory (Join-Path $projectRoot 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'web.log') -RedirectStandardError (Join-Path $logRoot 'web-error.log')
    @{ api = @{id=$apiProcess.Id; started=$apiProcess.StartTime.ToUniversalTime().ToString('o')}; web = @{id=$webProcess.Id; started=$webProcess.StartTime.ToUniversalTime().ToString('o')} } | ConvertTo-Json | Set-Content (Join-Path $logRoot 'processes.json')
    Write-Output 'Ziipa is starting at http://localhost:5178/ — logs are in .local/'
} finally { Pop-Location }
