[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FR_comfyui_next',
    [string]$TransactionRoot = 'C:\FR_comfyui_cache\.fr-control-center\transactions\manager'
)

$ErrorActionPreference = 'Stop'
$transactionId = "manager-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$transactionDir = Join-Path $TransactionRoot $transactionId
$configPath = Join-Path $InstallRoot 'ComfyUI\user\__manager\config.ini'
$backupPath = Join-Path $transactionDir 'previous-config.ini'
$manifestPath = Join-Path $transactionDir 'manifest.json'
$content = @"
[default]
security_level = normal
network_mode = public
allow_git_url_install = false
allow_pip_install = false
"@ -replace "`r`n", "`n"

if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'ComfyUI\.venv\Lib\site-packages\comfyui_manager-4.2.2.dist-info'))) {
    throw 'Manager v4 package 4.2.2 was not found in the managed runtime.'
}

New-Item -ItemType Directory -Force -Path $transactionDir | Out-Null
$previousExists = Test-Path -LiteralPath $configPath
$previousHash = $null
if ($previousExists) {
    Copy-Item -LiteralPath $configPath -Destination $backupPath
    $previousHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
}

$manifest = [ordered]@{
    version = 1
    transactionId = $transactionId
    startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    installRoot = $InstallRoot
    configPath = $configPath
    previousExists = $previousExists
    previousHash = $previousHash
    intended = [ordered]@{
        security_level = 'normal'
        network_mode = 'public'
        allow_git_url_install = $false
        allow_pip_install = $false
    }
    status = 'prepared'
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

$parent = Split-Path -Parent $configPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$temporary = "$configPath.fr-$transactionId.tmp"
try {
    [IO.File]::WriteAllText($temporary, $content, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $configPath) {
        [IO.File]::Replace($temporary, $configPath, $null)
    }
    else {
        Move-Item -LiteralPath $temporary -Destination $configPath
    }
    $actualHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    $manifest.status = 'committed'
    $manifest.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $manifest.actualHash = $actualHash
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $manifest | ConvertTo-Json -Depth 6
}
catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    if ($previousExists -and (Test-Path -LiteralPath $backupPath)) {
        Copy-Item -LiteralPath $backupPath -Destination $configPath -Force
    }
    elseif (-not $previousExists) {
        Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    }
    $manifest.status = 'rolled-back'
    $manifest.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $manifest.error = $_.Exception.Message
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    throw
}
