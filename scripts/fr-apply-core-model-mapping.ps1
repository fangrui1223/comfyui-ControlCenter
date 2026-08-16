[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$InventoryPath = 'C:\FR_comfyui_cache\catalogs\shared-model-inventory.json',
  [string]$EnvironmentRoot = 'C:\FR_comfyui_next',
  [string]$EvidencePath = 'C:\FR_comfyui_cache\catalogs\next-core-model-mapping-plan.json'
)

$ErrorActionPreference = 'Stop'
$environment = [IO.Path]::GetFullPath($EnvironmentRoot).TrimEnd('\')
$expected = [IO.Path]::GetFullPath('C:\FR_comfyui_next').TrimEnd('\')
if ($environment -ine $expected) { throw "Refusing unexpected environment: $environment" }
if (-not (Test-Path -LiteralPath $InventoryPath -PathType Leaf)) { throw 'Model inventory is missing.' }
$ownerPath = Join-Path $environment '.fr-control-center\ownership.json'
$runtimePath = Join-Path $environment '.fr-control-center\runtime.json'
if (-not (Test-Path -LiteralPath $ownerPath) -or -not (Test-Path -LiteralPath $runtimePath)) {
  throw 'The next environment is not FR-owned and runtime-validated.'
}
$owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
if ($owner.product -ne 'FR ComfyUI Control Center' -or $owner.kind -ne 'next') { throw 'FR ownership marker mismatch.' }
$inventory = Get-Content -LiteralPath $InventoryPath -Raw | ConvertFrom-Json
if ($inventory.schemaVersion -ne 1 -or $inventory.sharedRoot -ine 'C:\FR_comfyui\models') { throw 'Inventory root/schema mismatch.' }
if (@($inventory.errors).Count -gt 0) { throw 'Inventory contains scan errors.' }
$coreCommit = (& git -C (Join-Path $environment 'ComfyUI') rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $coreCommit -ne $inventory.coreSourceCommit) { throw 'Core changed after model inventory.' }

$categories = [ordered]@{}
$excluded = [Collections.Generic.List[object]]::new()
foreach ($record in @($inventory.records | Sort-Object Name)) {
  if ($record.Disposition -eq 'core-extra-path' -and $record.LogicalCategory) {
    $source = [IO.Path]::GetFullPath([string]$record.PhysicalPath)
    if (-not $source.StartsWith('C:\FR_comfyui\models\', [StringComparison]::OrdinalIgnoreCase)) { throw "Source escaped shared root: $source" }
    $item = Get-Item -LiteralPath $source -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Source changed after scan: $source" }
    if (-not $categories.Contains($record.LogicalCategory)) { $categories[$record.LogicalCategory] = [Collections.Generic.List[string]]::new() }
    $categories[$record.LogicalCategory].Add($source)
  } else {
    $excluded.Add([pscustomobject]@{ Name=$record.Name;Reason=if($record.Disposition -eq 'plugin-verification-required'){'Requires installed-plugin path evidence'}else{[string]$record.Warning} })
  }
}
foreach ($key in @($categories.Keys)) {
  $sorted = @($categories[$key] | Sort-Object)
  $categories[$key] = $sorted
}

$transactionId = 'models-{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'),([guid]::NewGuid().ToString('N').Substring(0,8))
$mappingRoot = Join-Path $environment '.fr-control-center\model-mappings'
$configPath = Join-Path $mappingRoot 'extra_model_paths.yaml'
$manifestPath = Join-Path $mappingRoot 'manifest.json'
$undoPath = Join-Path $mappingRoot 'undo.json'
$collisions = @($configPath,$manifestPath,$undoPath | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {[pscustomobject]@{Path=$_;Reason='Existing mapping transaction output'}})
$unsigned = [ordered]@{
  schemaVersion = 1
  transactionId = $transactionId
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  mode = if($Apply){'apply'}else{'dry-run'}
  sharedRoot = $inventory.sharedRoot
  environmentRoot = $environment
  configPath = $configPath
  manifestPath = $manifestPath
  undoManifestPath = $undoPath
  coreSourceCommit = $coreCommit
  categoryPaths = $categories
  excluded = @($excluded)
  collisions = $collisions
  blocked = $collisions.Count -gt 0
}
$json = $unsigned | ConvertTo-Json -Depth 12 -Compress
$digestBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))
$digest = [Convert]::ToHexString($digestBytes).ToLowerInvariant()
$plan = [ordered]@{} + $unsigned
$plan.digest = $digest
$evidenceParent = Split-Path -Parent $EvidencePath
if ($evidenceParent) { New-Item -ItemType Directory -Force -Path $evidenceParent | Out-Null }
$plan | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
[pscustomobject]@{TransactionId=$transactionId;Mode=$unsigned.mode;Categories=$categories.Count;Excluded=$excluded.Count;Collisions=$collisions.Count;Blocked=$unsigned.blocked;Digest=$digest;Evidence=$EvidencePath} | ConvertTo-Json
if (-not $Apply) { return }
if ($unsigned.blocked) { throw 'Model mapping plan is blocked.' }

New-Item -ItemType Directory -Force -Path $mappingRoot | Out-Null
$created = [Collections.Generic.List[string]]::new()
try {
  foreach ($file in @($configPath,$manifestPath,$undoPath)) {
    $stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $stream.Dispose()
    $created.Add($file)
  }
  $yaml = [Text.StringBuilder]::new()
  [void]$yaml.AppendLine('fr_shared_models:')
  [void]$yaml.AppendLine('  is_default: false')
  foreach ($key in @($categories.Keys | Sort-Object)) {
    [void]$yaml.AppendLine("  ${key}: |-")
    foreach ($source in $categories[$key]) { [void]$yaml.AppendLine("    $source") }
  }
  $tempConfig = "$configPath.tmp-$transactionId"
  $yaml.ToString() | Set-Content -LiteralPath $tempConfig -Encoding utf8
  Move-Item -LiteralPath $tempConfig -Destination $configPath -Force
  $plan | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath "$manifestPath.tmp-$transactionId" -Encoding utf8
  Move-Item -LiteralPath "$manifestPath.tmp-$transactionId" -Destination $manifestPath -Force
  $undo = [ordered]@{schemaVersion=1;transactionId=$transactionId;createdFiles=@($configPath,$manifestPath,$undoPath);createdJunctions=@()}
  $undo | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$undoPath.tmp-$transactionId" -Encoding utf8
  Move-Item -LiteralPath "$undoPath.tmp-$transactionId" -Destination $undoPath -Force
} catch {
  foreach ($file in @($created)) { if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force} }
  throw
}

foreach ($record in $inventory.records) {
  if ($record.Disposition -eq 'core-extra-path') { $record.ReferencedBy = @('stable','next') }
}
$inventory | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $InventoryPath -Encoding utf8

