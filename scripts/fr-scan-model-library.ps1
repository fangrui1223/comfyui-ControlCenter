[CmdletBinding()]
param(
  [string]$SharedRoot = 'C:\FR_comfyui\models',
  [string]$FolderPathsFile = 'C:\FR_comfyui_next\ComfyUI\folder_paths.py',
  [string]$OutputPath = 'C:\FR_comfyui_cache\catalogs\shared-model-inventory.json'
)

$ErrorActionPreference = 'Stop'
$shared = [IO.Path]::GetFullPath($SharedRoot).TrimEnd('\')
$expected = [IO.Path]::GetFullPath('C:\FR_comfyui\models').TrimEnd('\')
if ($shared -ine $expected) { throw "Refusing unexpected shared model root: $shared" }
if (-not (Test-Path -LiteralPath $shared -PathType Container)) { throw 'Shared model root is missing.' }
if (-not (Test-Path -LiteralPath $FolderPathsFile -PathType Leaf)) { throw 'Core folder_paths.py is missing.' }

$source = Get-Content -LiteralPath $FolderPathsFile -Raw
$categories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($match in [regex]::Matches($source, 'folder_names_and_paths\[\s*["'']([^"'']+)["'']\s*\]\s*=')) {
  [void]$categories.Add($match.Groups[1].Value)
}
$aliases = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$legacy = [regex]::Match($source, 'legacy\s*=\s*\{([\s\S]*?)\}')
if ($legacy.Success) {
  foreach ($match in [regex]::Matches($legacy.Groups[1].Value, '["'']([^"'']+)["'']\s*:\s*["'']([^"'']+)["'']')) {
    $aliases[$match.Groups[1].Value] = $match.Groups[2].Value
  }
}

function Measure-PhysicalDirectory([string]$Root) {
  [int64]$bytes = 0
  [int64]$files = 0
  [int64]$directories = 0
  $errors = [Collections.Generic.List[object]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    try {
      foreach ($entry in [IO.DirectoryInfo]::new($current).EnumerateFileSystemInfos()) {
        try {
          if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $errors.Add([pscustomobject]@{ Path = $entry.FullName; Message = 'Nested reparse point was not followed' })
          } elseif ($entry -is [IO.DirectoryInfo]) {
            $directories++
            $pending.Push($entry.FullName)
          } elseif ($entry -is [IO.FileInfo]) {
            $files++
            $bytes += $entry.Length
          }
        } catch {
          $errors.Add([pscustomobject]@{ Path = $entry.FullName; Message = $_.Exception.Message })
        }
      }
    } catch {
      $errors.Add([pscustomobject]@{ Path = $current; Message = $_.Exception.Message })
    }
  }
  [pscustomobject]@{ Bytes = $bytes; Files = $files; Directories = $directories; Errors = @($errors) }
}

$coreCommit = (& git -C (Split-Path -Parent $FolderPathsFile) rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve next Core commit.' }
$records = [Collections.Generic.List[object]]::new()
$errors = [Collections.Generic.List[object]]::new()
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in @(Get-ChildItem -LiteralPath $shared -Force | Sort-Object Name)) {
  $isReparse = ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  $logical = if ($categories.Contains($entry.Name)) { $entry.Name } elseif ($aliases.ContainsKey($entry.Name)) { $aliases[$entry.Name] } else { $null }
  if (-not $seen.Add($entry.Name)) {
    $records.Add([pscustomobject]@{ Name=$entry.Name;PhysicalPath=$entry.FullName;Bytes=0;Files=0;Directories=0;ReparsePoint=$isReparse;Disposition='blocked';LogicalCategory=$null;ReferencedBy=@('stable');Warning='Case-insensitive top-level collision' })
    continue
  }
  if (-not $entry.PSIsContainer -or $isReparse) {
    $records.Add([pscustomobject]@{ Name=$entry.Name;PhysicalPath=$entry.FullName;Bytes=0;Files=0;Directories=0;ReparsePoint=$isReparse;Disposition='blocked';LogicalCategory=$logical;ReferencedBy=@('stable');Warning=if($isReparse){'Existing reparse point was not followed'}else{'Top-level model entry is not a directory'} })
    continue
  }
  $measurement = Measure-PhysicalDirectory $entry.FullName
  foreach ($error in $measurement.Errors) { $errors.Add($error) }
  $records.Add([pscustomobject]@{
    Name = $entry.Name
    PhysicalPath = $entry.FullName
    Bytes = $measurement.Bytes
    Files = $measurement.Files
    Directories = $measurement.Directories
    ReparsePoint = $false
    Disposition = if($logical){'core-extra-path'}else{'plugin-verification-required'}
    LogicalCategory = $logical
    ReferencedBy = @('stable')
    Warning = $null
  })
}
$document = [ordered]@{
  schemaVersion = 1
  scannedAt = (Get-Date).ToUniversalTime().ToString('o')
  sharedRoot = $shared
  coreSourceCommit = $coreCommit
  totalBytes = [int64](($records | Measure-Object -Property Bytes -Sum).Sum)
  totalFiles = [int64](($records | Measure-Object -Property Files -Sum).Sum)
  records = @($records)
  errors = @($errors)
}
$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$document | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8
[pscustomobject]@{
  Output = $OutputPath
  Records = $records.Count
  CoreMapped = @($records | Where-Object Disposition -eq 'core-extra-path').Count
  PluginVerificationRequired = @($records | Where-Object Disposition -eq 'plugin-verification-required').Count
  Blocked = @($records | Where-Object Disposition -eq 'blocked').Count
  TotalBytes = $document.totalBytes
  TotalFiles = $document.totalFiles
  Errors = $errors.Count
} | ConvertTo-Json

