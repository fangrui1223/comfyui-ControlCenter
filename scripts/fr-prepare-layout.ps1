[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Execute,
  [string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
$targets = [ordered]@{
  next = 'C:\FR_comfyui_next'
  lab = 'C:\FR_comfyui_lab'
  cache = 'C:\FR_comfyui_cache'
}
$stableRoot = 'C:\FR_comfyui'
$sharedModelsRoot = 'C:\FR_comfyui\models'
$transactionId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$minimumFree = 20GB

function Get-TargetState([string]$Kind, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Target)) {
    return [pscustomobject]@{ Kind = $Kind; Path = $Target; State = 'missing'; OwnerRole = $null }
  }
  $item = Get-Item -LiteralPath $Target -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return [pscustomobject]@{ Kind = $Kind; Path = $Target; State = 'occupied'; OwnerRole = $null }
  }
  $entries = @(Get-ChildItem -LiteralPath $Target -Force)
  if ($entries.Count -eq 0) {
    return [pscustomobject]@{ Kind = $Kind; Path = $Target; State = 'empty-unowned'; OwnerRole = $null }
  }
  $marker = Join-Path $Target '.fr-control-center\ownership.json'
  if (Test-Path -LiteralPath $marker) {
    try {
      $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ($owner.schemaVersion -eq 1 -and $owner.product -eq 'FR ComfyUI Control Center' -and $owner.state -eq 'prepared') {
        return [pscustomobject]@{ Kind = $Kind; Path = $Target; State = 'owned'; OwnerRole = $owner.kind }
      }
    } catch {}
  }
  return [pscustomobject]@{ Kind = $Kind; Path = $Target; State = 'occupied'; OwnerRole = $null }
}

function Get-RelativeDirectories([string]$Kind) {
  if ($Kind -eq 'cache') {
    return @('.fr-control-center', '.fr-control-center\transactions', 'catalogs', 'downloads', 'logs', 'probes', 'wheels')
  }
  return @('.fr-control-center', '.fr-control-center\compiled-cache', '.fr-control-center\logs', '.fr-control-center\snapshots', '.fr-control-center\staging', '.fr-control-center\transactions')
}

$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($targets.next).Substring(0, 1))
$states = @($targets.GetEnumerator() | ForEach-Object { Get-TargetState $_.Key $_.Value })
$blocked = @($states | Where-Object {
  $_.State -in @('occupied', 'empty-unowned') -or ($_.State -eq 'owned' -and $_.OwnerRole -ne $_.Kind)
})
if ($drive.Free -lt $minimumFree) {
  $blocked += [pscustomobject]@{ Kind = 'disk'; Path = $drive.Root; State = 'less-than-20GiB'; OwnerRole = $null }
}

$plan = [ordered]@{
  schemaVersion = 1
  transactionId = $transactionId
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  mode = if ($Execute) { 'execute' } else { 'dry-run' }
  stableRoot = $stableRoot
  sharedModelsRoot = $sharedModelsRoot
  sharedModelsPolicy = 'read-only-no-scan-no-write'
  freeBytes = [int64]$drive.Free
  targets = $states
  blocked = $blocked.Count -gt 0
}

if ($EvidencePath) {
  $evidenceParent = Split-Path -Parent $EvidencePath
  if ($evidenceParent) { New-Item -ItemType Directory -Force -Path $evidenceParent | Out-Null }
  $plan | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
}
$plan | ConvertTo-Json -Depth 6

if (-not $Execute) { return }
if ($plan.blocked) { throw 'FR layout execution is blocked by preflight.' }

$journalRoot = Join-Path $env:APPDATA 'FR-ComfyUI-ControlCenter\transactions\environment-layout'
New-Item -ItemType Directory -Force -Path $journalRoot | Out-Null
$journalPath = Join-Path $journalRoot ($transactionId + '.json')
$journal = [ordered]@{
  schemaVersion = 1
  transactionId = $transactionId
  status = 'executing'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  finishedAt = $null
  createdRoots = @()
  error = $null
}
$journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $journalPath -Encoding utf8

try {
  foreach ($state in $states) {
    if ($state.State -eq 'owned') { continue }
    $stage = '{0}.fr-stage-{1}' -f $state.Path, $transactionId
    if (Test-Path -LiteralPath $stage) { throw "Staging path already exists: $stage" }
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
      foreach ($relative in (Get-RelativeDirectories $state.Kind)) {
        New-Item -ItemType Directory -Force -Path (Join-Path $stage $relative) | Out-Null
      }
      $marker = [ordered]@{
        schemaVersion = 1
        product = 'FR ComfyUI Control Center'
        kind = $state.Kind
        state = 'prepared'
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        transactionId = $transactionId
      }
      $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage '.fr-control-center\ownership.json') -Encoding utf8
      Move-Item -LiteralPath $stage -Destination $state.Path
      $journal.createdRoots += $state.Path
      $journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $journalPath -Encoding utf8
    } catch {
      if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
      throw
    }
  }
  $journal.status = 'committed'
} catch {
  $journal.error = $_.Exception.Message
  $rollbackRoots = @($journal.createdRoots)
  [array]::Reverse($rollbackRoots)
  foreach ($root in $rollbackRoots) {
    $markerPath = Join-Path $root '.fr-control-center\ownership.json'
    if (-not (Test-Path -LiteralPath $markerPath)) { continue }
    $owner = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($owner.transactionId -eq $transactionId -and $owner.state -eq 'prepared') {
      Remove-Item -LiteralPath $root -Recurse -Force
    }
  }
  $journal.status = if ($journal.createdRoots.Count) { 'rolled-back' } else { 'failed' }
  throw
} finally {
  $journal.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $journal | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $journalPath -Encoding utf8
}
