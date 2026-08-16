[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SnapshotPath,
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $SnapshotPath 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Restore manifest is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$installRoot = [string]$manifest.installRoot
$ownership = Join-Path $installRoot '.fr-control-center\ownership.json'
if (-not (Test-Path -LiteralPath $ownership)) { throw 'Target ownership marker is missing.' }

$plan = [ordered]@{
    snapshotPath = $SnapshotPath
    installRoot = $installRoot
    coreCommit = [string]$manifest.core.commit
    coreBundle = (Join-Path $SnapshotPath ([string]$manifest.core.bundle))
    files = @($manifest.files.PSObject.Properties | ForEach-Object {
        [ordered]@{ name = $_.Name; source = [string]$_.Value.source; snapshot = (Join-Path $SnapshotPath ([string]$_.Value.snapshot)); expectedSha256 = [string]$_.Value.sha256 }
    })
    pythonPackages = (Join-Path $SnapshotPath ([string]$manifest.python.packages))
    requiresRuntimePackageReconciliation = $true
    modelLibraryMutation = $false
}

if (-not $Execute) {
    $plan | ConvertTo-Json -Depth 8
    return
}

throw 'Execution is intentionally fail-closed until the Control Center has stopped the environment and created a pre-restore safety snapshot. Use the in-app restore transaction.'

