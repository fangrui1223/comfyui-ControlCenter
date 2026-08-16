[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FR_comfyui_next',
    [string]$CacheRoot = 'C:\FR_comfyui_cache'
)

$ErrorActionPreference = 'Stop'
$timestamp = [DateTimeOffset]::UtcNow
$restoreId = "baseline-$($timestamp.ToString('yyyyMMddHHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$snapshotParent = Join-Path $InstallRoot '.fr-control-center\snapshots'
$staging = Join-Path $snapshotParent ".$restoreId.staging"
$destination = Join-Path $snapshotParent $restoreId
$transactionDir = Join-Path $CacheRoot ".fr-control-center\transactions\update\$restoreId"
$manifestPath = Join-Path $staging 'manifest.json'
$comfyRoot = Join-Path $InstallRoot 'ComfyUI'
$python = Join-Path $comfyRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.fr-control-center\ownership.json'))) {
    throw 'The target does not have an FR ownership marker.'
}
if (-not (Test-Path -LiteralPath (Join-Path $comfyRoot '.git'))) {
    throw 'The managed Core checkout is not a Git repository.'
}
if (-not (Test-Path -LiteralPath $python)) {
    throw 'The managed Python interpreter is missing.'
}
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $staging)) {
    throw "Restore point already exists: $restoreId"
}

$dirty = @(git -C $comfyRoot status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'Refusing to snapshot a dirty or unreadable Core working tree.'
}

$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallRoot, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
    throw "Managed environment is running (PID $($running[0].ProcessId))."
}

New-Item -ItemType Directory -Force -Path $staging, $transactionDir | Out-Null
try {
    $coreCommit = (git -C $comfyRoot rev-parse HEAD).Trim()
    $coreTag = (git -C $comfyRoot describe --tags --exact-match HEAD 2>$null).Trim()
    $coreRemote = (git -C $comfyRoot remote get-url origin).Trim()
    git -C $comfyRoot bundle create (Join-Path $staging 'core.bundle') HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the offline Core bundle.' }

    & $python -m pip freeze --all | Set-Content -LiteralPath (Join-Path $staging 'python-packages.txt') -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw 'Failed to capture the Python package lock.' }

    $capture = [ordered]@{}
    $files = [ordered]@{
        ownership = (Join-Path $InstallRoot '.fr-control-center\ownership.json')
        runtime = (Join-Path $InstallRoot '.fr-control-center\runtime.json')
        runtimeLock = (Join-Path $InstallRoot '.fr-control-center\runtime-lock.txt')
        managerConfig = (Join-Path $comfyRoot 'user\__manager\config.ini')
        modelMapping = (Join-Path $InstallRoot '.fr-control-center\model-mappings\extra_model_paths.yaml')
        modelMappingManifest = (Join-Path $InstallRoot '.fr-control-center\model-mappings\manifest.json')
    }
    foreach ($item in $files.GetEnumerator()) {
        if (-not (Test-Path -LiteralPath $item.Value)) { throw "Required baseline file is missing: $($item.Value)" }
        $name = "$($item.Key)$([IO.Path]::GetExtension($item.Value))"
        Copy-Item -LiteralPath $item.Value -Destination (Join-Path $staging $name)
        $capture[$item.Key] = [ordered]@{
            source = $item.Value
            snapshot = $name
            sha256 = (Get-FileHash -LiteralPath $item.Value -Algorithm SHA256).Hash
        }
    }

    $customNodes = @()
    $customNodesRoot = Join-Path $comfyRoot 'custom_nodes'
    if (Test-Path -LiteralPath $customNodesRoot) {
        $customNodes = @(Get-ChildItem -LiteralPath $customNodesRoot -Force | Where-Object {
            $_.Name -notin @('__pycache__', 'websocket_image_save.py.example')
        } | ForEach-Object {
            [ordered]@{ name = $_.Name; directory = $_.PSIsContainer; lastWriteAt = $_.LastWriteTimeUtc.ToString('o') }
        })
    }

    $manifest = [ordered]@{
        version = 1
        restorePointId = $restoreId
        createdAt = $timestamp.ToString('o')
        installRoot = $InstallRoot
        state = 'committed'
        core = [ordered]@{ commit = $coreCommit; tag = $coreTag; remote = $coreRemote; dirty = $false; bundle = 'core.bundle' }
        python = [ordered]@{ executable = $python; packages = 'python-packages.txt' }
        files = $capture
        customNodes = $customNodes
        modelFilesCaptured = $false
        modelLibraryModified = $false
        restoreTool = 'scripts/fr-restore-update-point.ps1'
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $staging -Destination $destination
    [IO.File]::WriteAllText((Join-Path $transactionDir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $manifest | ConvertTo-Json -Depth 10
}
catch {
    if (Test-Path -LiteralPath $staging) {
        Move-Item -LiteralPath $staging -Destination (Join-Path $transactionDir 'failed-staging') -ErrorAction SilentlyContinue
    }
    throw
}
