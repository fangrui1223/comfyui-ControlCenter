[CmdletBinding()]
param(
  [string]$DistDirectory
)

$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -Force -ErrorAction Stop

if ([string]::IsNullOrWhiteSpace($DistDirectory)) {
  $DistDirectory = Join-Path $PSScriptRoot '..\dist'
}
$resolvedDist = (Resolve-Path -LiteralPath $DistDirectory).Path
$appPath = Join-Path $resolvedDist 'win-unpacked\FR ComfyUI Control Center.exe'
$installer = Get-ChildItem -LiteralPath $resolvedDist -File -Filter 'FR-ComfyUI-ControlCenter-*-win-x64.exe' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
  throw "Signed release verification failed: packaged app not found at $appPath"
}
if ($null -eq $installer) {
  throw "Signed release verification failed: installer not found in $resolvedDist"
}

$targets = @($appPath, $installer.FullName)
foreach ($target in $targets) {
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid') {
    throw "Signed release verification failed for $target (status: $($signature.Status); message: $($signature.StatusMessage))"
  }

  [PSCustomObject]@{
    File = $target
    Status = $signature.Status
    Subject = $signature.SignerCertificate.Subject
    Thumbprint = $signature.SignerCertificate.Thumbprint
    TimestampSubject = $signature.TimeStamperCertificate.Subject
  } | Format-List
}

Write-Host 'Windows signature verification passed for the packaged app and installer.'
