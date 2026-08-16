[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FR_comfyui_next',
    [string]$ModelConfig = 'C:\FR_comfyui_next\.fr-control-center\model-mappings\extra_model_paths.yaml',
    [string]$OutputPath = 'C:\FR_comfyui_cache\probes\manager-v4-api.json',
    [int]$Port = 8291
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $InstallRoot 'ComfyUI\.venv\Scripts\python.exe'
$main = Join-Path $InstallRoot 'ComfyUI\main.py'
$working = Join-Path $InstallRoot 'ComfyUI'
$stdoutLog = [IO.Path]::ChangeExtension($OutputPath, '.stdout.log')
$stderrLog = [IO.Path]::ChangeExtension($OutputPath, '.stderr.log')
$origin = "http://127.0.0.1:$Port"

if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $main)) {
    throw "Managed runtime is incomplete: $InstallRoot"
}
if (Test-Path -LiteralPath $OutputPath) {
    throw "Refusing to overwrite an existing probe report: $OutputPath"
}

$arguments = @(
    $main,
    '--enable-manager',
    '--disable-all-custom-nodes',
    '--listen', '127.0.0.1',
    '--port', $Port,
    '--extra-model-paths-config', $ModelConfig,
    '--disable-xformers',
    '--use-pytorch-cross-attention'
)
$process = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $working -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -PassThru
$startedAt = [DateTimeOffset]::UtcNow
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($process.HasExited) {
            throw "ComfyUI exited before the Manager API became ready (exit $($process.ExitCode))."
        }
        try {
            $null = Invoke-RestMethod -Uri "$origin/system_stats" -TimeoutSec 2
            $ready = $true
            break
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $ready) { throw 'Timed out waiting for the Manager v4 probe server.' }

    $version = Invoke-RestMethod -Uri "$origin/api/v2/manager/version" -TimeoutSec 10
    $installed = Invoke-RestMethod -Uri "$origin/api/v2/customnode/installed" -TimeoutSec 30
    $probeTarget = "fr-nonexistent-$([guid]::NewGuid().ToString('N'))"
    $removeResponse = Invoke-WebRequest -Method Post -Uri "$origin/api/v2/snapshot/remove?target=$probeTarget" -ContentType 'application/json' -TimeoutSec 10
    $result = [ordered]@{
        version = 1
        probedAt = [DateTimeOffset]::UtcNow.ToString('o')
        origin = $origin
        managerVersion = [string]$version
        installedEndpointType = $installed.GetType().Name
        installedCount = @($installed).Count
        snapshotRemoveStatus = [int]$removeResponse.StatusCode
        listen = '127.0.0.1'
        api = 'v2'
        elapsedSeconds = [math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 3)
        stdoutLogPath = $stdoutLog
        stderrLogPath = $stderrLog
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    [IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $result | ConvertTo-Json -Depth 5
}
finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(10000) | Out-Null
    }
}
