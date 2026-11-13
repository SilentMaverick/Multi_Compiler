#requires -Version 5.1
<#
  vendor-assets.ps1
  Fetches the editor assets (CodeMirror 5) into public\vendor so the IDE works
  completely offline afterwards. Safe to re-run; existing files are kept unless -Force.
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'public\vendor'
New-Item -ItemType Directory -Force -Path $Vendor | Out-Null

$version = '5.65.16'
$base = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/$version"

$assets = @(
  @{ url = "$base/codemirror.min.js";                                        out = 'codemirror.min.js'; min = 150000 },
  @{ url = "$base/codemirror.min.css";                                       out = 'codemirror.min.css'; min = 5000 },
  @{ url = "$base/mode/clike/clike.min.js";                                  out = 'clike.min.js'; min = 8000 },
  @{ url = "$base/mode/python/python.min.js";                                out = 'python.min.js'; min = 5000 },
  @{ url = "$base/mode/javascript/javascript.min.js";                        out = 'javascript.min.js'; min = 5000 },
  @{ url = "$base/addon/edit/matchbrackets.min.js";                          out = 'matchbrackets.min.js'; min = 1000 },
  @{ url = "$base/addon/selection/active-line.min.js";                       out = 'active-line.min.js'; min = 1000 }
)

foreach ($a in $assets) {
  $dest = Join-Path $Vendor $a.out
  if ((Test-Path $dest) -and -not $Force) {
    Write-Host "  keep   $($a.out)"
    continue
  }
  Write-Host "  fetch  $($a.out)"
  & curl.exe -L --fail --silent --show-error --retry 3 --connect-timeout 20 -o $dest $a.url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $($a.url)" }
  $size = (Get-Item $dest).Length
  if ($size -lt $a.min) { throw "$($a.out) looks wrong ($size bytes, expected >= $($a.min))" }
}

Write-Host "vendor assets ready in $Vendor"
