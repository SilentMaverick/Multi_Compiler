#requires -Version 5.1
<#
  build-jobrunner.ps1
  Compiles native\jobrunner.cs into native\bin\jobrunner.exe using the C# compiler
  that ships with the .NET Framework. If that compiler is unavailable the server
  still works, just without kernel-level memory limits.
#>
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root 'native\jobrunner.cs'
$OutDir = Join-Path $Root 'native\bin'
$Out = Join-Path $OutDir 'jobrunner.exe'

if (-not (Test-Path $Src)) { throw "missing source: $Src" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ }

if (-not $cscCandidates) {
  Write-Host 'csc.exe not found; skipping native launcher (userspace fallback will be used).'
  exit 0
}
$csc = $cscCandidates[0]

if ((Test-Path $Out) -and -not $Quiet -and $false) { }
& $csc /nologo /target:exe /platform:anycpu /optimize+ /warn:0 "/out:$Out" $Src
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $Out)) { throw "compiler produced no output at $Out" }

$size = [math]::Round((Get-Item $Out).Length / 1KB, 1)
Write-Host "jobrunner built: $Out ($size KB)"

# The pseudo-console host is what gives the Terminal tab real echo and colour.
$PtySrc = Join-Path $Root 'native\ptyhost.cs'
$PtyOut = Join-Path $OutDir 'ptyhost.exe'
if (Test-Path $PtySrc) {
  & $csc /nologo /target:exe /platform:anycpu /optimize+ /warn:0 "/out:$PtyOut" $PtySrc
  if ($LASTEXITCODE -ne 0) { throw "csc failed building ptyhost (exit $LASTEXITCODE)" }
  $ptysize = [math]::Round((Get-Item $PtyOut).Length / 1KB, 1)
  Write-Host "ptyhost built:   $PtyOut ($ptysize KB)"
}
