[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FR_comfyui_next'
)

$ErrorActionPreference = 'Stop'

$comfyRoot = Join-Path $InstallRoot 'ComfyUI'
$managerDir = Join-Path $comfyRoot 'user\__manager'
$blacklistPath = Join-Path $managerDir 'pip_blacklist.list'
$policyDir = Join-Path $InstallRoot '.fr-control-center\policies'
$policyPath = Join-Path $policyDir 'impact-pack-no-sam2.json'

if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.fr-control-center\ownership.json'))) {
    throw 'The target does not have an FR ownership marker.'
}
if (-not (Test-Path -LiteralPath $comfyRoot)) {
    throw "ComfyUI root not found: $comfyRoot"
}

New-Item -ItemType Directory -Force -Path $managerDir, $policyDir | Out-Null

$entries = @()
if (Test-Path -LiteralPath $blacklistPath) {
    $entries = @(Get-Content -LiteralPath $blacklistPath | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$entries = @($entries + 'sam2' | Sort-Object -Unique)
[IO.File]::WriteAllText(
    $blacklistPath,
    (($entries -join [Environment]::NewLine) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)

$policy = [ordered]@{
    version = 1
    policyId = 'fr-impact-pack-no-sam2'
    installRoot = $InstallRoot
    plugin = 'comfyui-impact-pack'
    blockedPipPackage = 'sam2'
    reason = 'Keep Impact Pack non-SAM2 nodes available; SAM2/SAM2 Video Detector nodes remain intentionally unavailable.'
    mechanism = 'ComfyUI-Manager v4 pip_blacklist.list'
    reversible = $true
    rollback = "Remove 'sam2' from $blacklistPath and restart the installation."
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText(
    $policyPath,
    ($policy | ConvertTo-Json -Depth 6),
    [Text.UTF8Encoding]::new($false)
)

$policy | ConvertTo-Json -Depth 6
