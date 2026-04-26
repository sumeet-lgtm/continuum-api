# Continuum — Railway deploy for Windows PowerShell
# Usage: .\scripts\deploy-railway.ps1

$ErrorActionPreference = "Stop"

Write-Host "`nContinuum Railway Deploy" -ForegroundColor Cyan
Write-Host "========================`n" -ForegroundColor Cyan

# Check railway is installed
if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Railway CLI..." -ForegroundColor Yellow
    npm install -g @railway/cli
}

# Load .env file
Write-Host "Loading .env..." -ForegroundColor Green
$envFile = Get-Content .env | Where-Object { $_ -notmatch "^#" -and $_ -match "=" }
$envVars = @{}
foreach ($line in $envFile) {
    $parts = $line -split "=", 2
    if ($parts.Length -eq 2) {
        $envVars[$parts[0].Trim()] = $parts[1].Trim()
    }
}

Write-Host "Pushing environment variables to Railway..." -ForegroundColor Green
foreach ($key in $envVars.Keys) {
    $val = $envVars[$key]
    if ($val -ne "") {
        railway variables set "$key=$val" 2>$null
    }
}
Write-Host "  Environment variables set" -ForegroundColor Green

Write-Host "`nDeploying API service..." -ForegroundColor Green
railway up --detach

Write-Host "`nDone! Check Railway dashboard for your live URL." -ForegroundColor Cyan
Write-Host "Then test: curl https://YOUR-URL.railway.app/health" -ForegroundColor Yellow
