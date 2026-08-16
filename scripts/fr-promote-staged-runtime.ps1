[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$TargetRoot,
  [Parameter(Mandatory = $true)][string]$CacheRoot,
  [Parameter(Mandatory = $true)][string]$ProfileId,
  [Parameter(Mandatory = $true)][string]$CoreVersion,
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ArchiveSha256,
  [Parameter(Mandatory = $true)][string]$ProbePath
)

$ErrorActionPreference = 'Stop'
$stage = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
$target = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
$cache = [IO.Path]::GetFullPath($CacheRoot).TrimEnd('\')
$expectedTarget = [IO.Path]::GetFullPath('C:\FR_comfyui_next').TrimEnd('\')
$expectedCache = [IO.Path]::GetFullPath('C:\FR_comfyui_cache').TrimEnd('\')
if ($target -ine $expectedTarget) { throw "Refusing unexpected target: $target" }
if ($cache -ine $expectedCache) { throw "Refusing unexpected cache: $cache" }
if (-not $stage.StartsWith($target + '\.fr-control-center\staging\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "Stage is outside the FR next staging area: $stage"
}

$targetOwnerPath = Join-Path $target '.fr-control-center\ownership.json'
if (-not (Test-Path -LiteralPath $targetOwnerPath)) { throw 'Target has no FR ownership marker.' }
$targetOwner = Get-Content -LiteralPath $targetOwnerPath -Raw | ConvertFrom-Json
if ($targetOwner.product -ne 'FR ComfyUI Control Center' -or $targetOwner.kind -ne 'next' -or $targetOwner.state -ne 'prepared') {
  throw 'Target ownership marker does not authorize next runtime promotion.'
}

$bundleManifestPath = Join-Path $stage 'manifest.json'
$pythonPath = Join-Path $stage 'ComfyUI\.venv\Scripts\python.exe'
$corePath = Join-Path $stage 'ComfyUI'
if (-not (Test-Path -LiteralPath $bundleManifestPath)) { throw 'Staged bundle manifest is missing.' }
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Staged .venv Python is missing.' }
if (-not (Test-Path -LiteralPath $ProbePath)) { throw 'Successful runtime probe evidence is missing.' }
$bundle = Get-Content -LiteralPath $bundleManifestPath -Raw | ConvertFrom-Json
$probe = Get-Content -LiteralPath $ProbePath -Raw | ConvertFrom-Json
if ($bundle.python_version -ne '3.13.12' -or $bundle.torch_version -ne '2.12.1+cu130') {
  throw 'Staged bundle tuple does not match the approved profile.'
}
if (-not $probe.cuda.available -or @($probe.cuda.tests | Where-Object status -ne 'pass').Count -gt 0) {
  throw 'Runtime probe did not pass every CUDA case.'
}
if (@($probe.accelerators | Where-Object status -ne 'pass').Count -gt 0) {
  throw 'Runtime accelerator probe did not pass.'
}
$resolvedCoreVersion = (& git -C $corePath describe --tags --exact-match).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCoreVersion -ne $CoreVersion) {
  throw "Staged Core is $resolvedCoreVersion, expected $CoreVersion"
}
$coreCommit = (& git -C $corePath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve staged Core commit.' }
$archive = Get-Item -LiteralPath $ArchivePath
$actualHash = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash
if ($actualHash -ine $ArchiveSha256) { throw 'Downloaded archive SHA-256 changed before promotion.' }

$transactionId = 'runtime-{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$journalDir = Join-Path $cache ".fr-control-center\transactions\runtime\$transactionId"
New-Item -ItemType Directory -Force -Path $journalDir | Out-Null
$journalPath = Join-Path $journalDir 'journal.json'
$journal = [ordered]@{
  schemaVersion = 1
  transactionId = $transactionId
  status = 'preparing'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  finishedAt = $null
  target = $target
  stage = $stage
  publishedStage = $null
  recoveryPath = $null
  error = $null
}
function Save-Journal {
  $journal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $journalPath -Encoding utf8
}
Save-Journal
$publishedStage = $null
$backup = $null

try {
  $metadata = Join-Path $stage '.fr-control-center'
  New-Item -ItemType Directory -Force -Path $metadata | Out-Null
  foreach ($relative in @('compiled-cache', 'logs', 'snapshots', 'staging', 'transactions')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $metadata $relative) | Out-Null
  }
  Copy-Item -LiteralPath $targetOwnerPath -Destination (Join-Path $metadata 'ownership.json') -Force
  Set-Content -LiteralPath (Join-Path $corePath '.comfy_environment') -Value 'local-desktop2-standalone' -Encoding utf8NoBOM

  $uvPath = Join-Path $stage 'standalone-env\uv.exe'
  & $uvPath pip freeze --python $pythonPath | Set-Content -LiteralPath (Join-Path $metadata 'runtime-lock.txt') -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Could not freeze the staged Python environment.' }
  $runtime = [ordered]@{
    schemaVersion = 1
    status = 'validated'
    profileId = $ProfileId
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    python = $probe.python.version
    torch = $probe.packages.torch
    torchvision = $probe.packages.torchvision
    torchaudio = $probe.packages.torchaudio
    transformers = $probe.packages.transformers
    tritonWindows = $probe.packages.'triton-windows'
    xformers = $probe.packages.xformers
    coreVersion = $resolvedCoreVersion
    coreCommit = $coreCommit
    bundleTag = $bundle.version
    bundleBytes = [int64]$archive.Length
    bundleSha256 = $actualHash
    probePath = $ProbePath
  }
  $runtime | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $metadata 'runtime.json') -Encoding utf8

  # A Windows venv records its base interpreter as an absolute `home` path.
  # The environment was built in staging, so rewrite it to the final target
  # immediately before publication; all staged probes have already completed.
  $pyvenvConfig = Join-Path $stage 'ComfyUI\.venv\pyvenv.cfg'
  $pyvenvContent = Get-Content -LiteralPath $pyvenvConfig -Raw
  if ($pyvenvContent -notmatch '(?m)^home\s*=') { throw 'Staged pyvenv.cfg has no home entry.' }
  $finalPythonHome = Join-Path $target 'standalone-env'
  $pyvenvContent = $pyvenvContent -replace '(?m)^home\s*=.*$', "home = $finalPythonHome"
  Set-Content -LiteralPath $pyvenvConfig -Value $pyvenvContent.TrimEnd() -Encoding utf8

  # Match official Desktop's post-install space recovery. Every recursive
  # target is resolved and proven to be a direct child of the staged master
  # site-packages; the validated .venv and cached source archive remain intact.
  $masterSite = [IO.Path]::GetFullPath((Join-Path $stage 'standalone-env\Lib\site-packages')).TrimEnd('\')
  foreach ($entry in @(Get-ChildItem -LiteralPath $masterSite -Directory)) {
    if ($entry.Name.ToLowerInvariant() -notmatch '^(torch|nvidia|triton|cuda)') { continue }
    $resolved = [IO.Path]::GetFullPath($entry.FullName).TrimEnd('\')
    if (-not $resolved.StartsWith($masterSite + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing unsafe master-package cleanup target: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }

  $publishedStage = "$target.fr-stage-$transactionId"
  $backup = "$target.fr-backup-$transactionId"
  if (Test-Path -LiteralPath $publishedStage) { throw "Published staging path exists: $publishedStage" }
  if (Test-Path -LiteralPath $backup) { throw "Runtime backup path exists: $backup" }
  Move-Item -LiteralPath $stage -Destination $publishedStage
  $journal.publishedStage = $publishedStage
  $journal.status = 'switching'
  Save-Journal

  Move-Item -LiteralPath $target -Destination $backup
  try {
    Move-Item -LiteralPath $publishedStage -Destination $target
  } catch {
    if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $target
    }
    throw
  }

  $activeRuntime = Join-Path $target '.fr-control-center\runtime.json'
  $activePython = Join-Path $target 'ComfyUI\.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $activeRuntime) -or -not (Test-Path -LiteralPath $activePython)) {
    throw 'Published runtime failed post-switch path verification.'
  }
  $recoveryPath = Join-Path $journalDir 'previous-layout'
  Move-Item -LiteralPath $backup -Destination $recoveryPath
  $journal.recoveryPath = $recoveryPath
  $journal.status = 'committed'
} catch {
  # If the new runtime was already published but the post-switch verification
  # or recovery move failed, restore the exact previous FR-owned layout. Keep
  # the failed runtime inside the transaction directory for diagnosis.
  if ($backup -and (Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $target)) {
    $failedRuntime = Join-Path $journalDir 'failed-runtime'
    if (-not (Test-Path -LiteralPath $failedRuntime)) {
      Move-Item -LiteralPath $target -Destination $failedRuntime
      Move-Item -LiteralPath $backup -Destination $target
    }
  }
  $journal.status = 'failed'
  $journal.error = $_.Exception.Message
  throw
} finally {
  $journal.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-Journal
}

[pscustomobject]@{
  TransactionId = $transactionId
  Status = $journal.status
  Target = $target
  Runtime = (Join-Path $target '.fr-control-center\runtime.json')
  Recovery = $journal.recoveryPath
  Journal = $journalPath
} | ConvertTo-Json -Depth 5
