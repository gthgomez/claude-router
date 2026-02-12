param(
  [string]$Scope = "jonathan-gomez-aguilars-projects",
  [string]$Project = "prismatix"
)

$ErrorActionPreference = "Stop"

$projectFile = Join-Path $PSScriptRoot ".vercel/project.json"

if (-not (Test-Path $projectFile)) {
  Write-Host "[deploy] No local Vercel link found. Linking to '$Project'..."
  vercel link --yes --scope $Scope --project $Project | Out-Null
}

$linked = Get-Content $projectFile | ConvertFrom-Json
if ($linked.projectName -ne $Project) {
  Write-Host "[deploy] Local link points to '$($linked.projectName)'. Re-linking to '$Project'..."
  vercel link --yes --scope $Scope --project $Project | Out-Null
  $linked = Get-Content $projectFile | ConvertFrom-Json
}

if ($linked.projectName -ne $Project) {
  throw "[deploy] Failed to link to '$Project'. Current link is '$($linked.projectName)'."
}

Write-Host "[deploy] Deploying '$Project' to production..."
vercel --prod --yes --scope $Scope
