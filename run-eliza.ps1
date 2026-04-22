#Requires -Version 5.1
<#
.SYNOPSIS
  Starts the ELIZA Next.js dev server with a clean Turbopack cache and a free port 3000.

.DESCRIPTION
  - Sets the working directory to this script's folder (project root).
  - Removes .next for a clean dev cache.
  - Stops any process listening on TCP port 3000.
  - Launches npm run dev in a new persistent PowerShell window.
  - Waits 3 seconds, then opens http://localhost:3000 in the default browser.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
if (-not $projectRoot) {
  $projectRoot = Get-Location
}

Set-Location -LiteralPath $projectRoot

Write-Host "ELIZA - project root: $projectRoot" -ForegroundColor Cyan

# --- Clean Turbopack / Next cache ---
$nextCache = Join-Path $projectRoot ".next"
if (Test-Path -LiteralPath $nextCache) {
  Write-Host "Removing .next cache..." -ForegroundColor Yellow
  Remove-Item -LiteralPath $nextCache -Recurse -Force
  Write-Host "Done." -ForegroundColor Green
} else {
  Write-Host "No .next folder to remove." -ForegroundColor DarkGray
}

# --- Free port 3000 (safeguarded) ---
try {
  $listeners = @(
    Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($listeners.Count -eq 0) {
    Write-Host "Port 3000 is free." -ForegroundColor DarkGray
  } else {
    foreach ($procId in $listeners) {
      if (-not $procId -or $procId -lt 100) { continue }
      Write-Host "Stopping process $procId using port 3000..." -ForegroundColor Yellow
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
      } catch {
        Write-Host "Could not stop PID $procId (may require elevated shell)." -ForegroundColor DarkYellow
      }
    }
  }
} catch {
  Write-Host "Port check or cleanup failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "package.json"))) {
  Write-Error "package.json not found. Is this script in the NyiroM-Eliza project root?"
  Read-Host "Press Enter to exit..."
  exit 1
}

# --- Dev server in a new persistent window ---
# Use single-quoted -Command so inner double-quotes for Write-Host do not break parsing.
Write-Host "Starting npm run dev in a new window..." -ForegroundColor Cyan
$null = Start-Process -FilePath "powershell.exe" -WorkingDirectory $projectRoot -ArgumentList @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  'Write-Host "ELIZA dev server (npm run dev) - close this window to stop." -ForegroundColor Cyan; npm run dev'
)

Start-Sleep -Seconds 3

Write-Host "Opening http://localhost:3000 ..." -ForegroundColor Cyan
Start-Process "http://localhost:3000/"

Write-Host "Launcher finished. Use the other PowerShell window for dev server logs." -ForegroundColor Green

Read-Host "Press Enter to exit..."
