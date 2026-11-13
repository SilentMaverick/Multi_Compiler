#requires -Version 5.1
<#
  bootstrap-toolchains.ps1
  Downloads self-contained toolchains into .\tools\ so no admin rights / installers are needed.

    tools\mingw64\  -> g++ (MinGW-w64, winlibs or w64devkit)
    tools\jdk21\    -> javac / java (Eclipse Temurin 21 LTS)

  Re-runnable: a component that already verifies is skipped. Downloads resume with
  HTTP ranges, because long transfers through a proxy tend to stall here.
#>
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root  = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'tools'
$Cache = Join-Path $Root '.cache'
$Log   = Join-Path $Cache 'bootstrap.log'

New-Item -ItemType Directory -Force -Path $Tools, $Cache | Out-Null
if (Test-Path $Log) { Remove-Item $Log -Force }

function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

# Invokes a native program and returns its exit code. Native stderr is not an
# exception, but PowerShell 5.1 turns it into one under ErrorActionPreference=Stop,
# so the preference is relaxed for the duration of the call.
function Run-Exe {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$ArgList = @(),
    [switch]$Quiet
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { & $Exe @ArgList 2>&1 | Out-Null } else { & $Exe @ArgList }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Test-Archive([string]$Archive) {
  if (-not (Test-Path $Archive)) { return $false }
  return (Run-Exe -Exe 'tar.exe' -ArgList @('-tf', $Archive) -Quiet) -eq 0
}

# Fetches an archive, resuming until the file is actually readable. Success is
# decided by testing the archive, not by curl's exit code or a size guess.
function Ensure-Archive($Url, $Archive, $MinBytes = 0) {
  $stall = 0
  for ($round = 1; $round -le 12; $round++) {
    if (Test-Archive $Archive) {
      Log ("  archive OK ({0:N1} MB)" -f ((Get-Item $Archive).Length / 1MB))
      return
    }

    $before = if (Test-Path $Archive) { (Get-Item $Archive).Length } else { 0 }
    $a = @('-L', '--fail', '--silent', '--show-error',
           '--connect-timeout', '25', '--max-time', '900',
           '--speed-limit', '10240', '--speed-time', '30')
    if ($before -gt 0) { $a += @('-C', '-') }
    $a += @('-o', $Archive, $Url)

    $code = Run-Exe -Exe 'curl.exe' -ArgList $a
    $after = if (Test-Path $Archive) { (Get-Item $Archive).Length } else { 0 }
    Log ("  round {0}: curl={1}  {2:N1} -> {3:N1} MB" -f $round, $code, ($before / 1MB), ($after / 1MB))

    if ($after -gt $before) { $stall = 0 }
    else {
      $stall++
      if ($stall -ge 4) { break }
      Start-Sleep -Seconds 4
    }
  }
  if (Test-Archive $Archive) {
    Log ("  archive OK ({0:N1} MB)" -f ((Get-Item $Archive).Length / 1MB))
    return
  }
  throw "could not obtain a complete archive (no progress after $stall attempts): $Archive"
}

function Extract-Zip($Archive, $DestDir) {
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  # bsdtar reads both .zip and .7z
  $code = Run-Exe -Exe 'tar.exe' -ArgList @('-xf', $Archive, '-C', $DestDir)
  if ($code -ne 0) { throw "tar extraction failed ($code) for $Archive" }
}

function Find-File($Base, $Name) {
  Get-ChildItem -Path $Base -Filter $Name -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Github-Asset($Repo, $Pattern, $Prefer = '*', $Exclude = '') {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
           -Headers @{ 'User-Agent' = 'multi-coder-bootstrap'; 'Accept' = 'application/vnd.github+json' } `
           -TimeoutSec 30
  $assets = $rel.assets
  Log ("  {0} latest = {1} ({2} assets)" -f $Repo, $rel.tag_name, $assets.Count)
  $pool = $assets | Where-Object {
    $_.name -match $Pattern -and ($Exclude -eq '' -or $_.name -notmatch $Exclude)
  }
  foreach ($p in @($Prefer, '*')) {
    $hit = $pool | Where-Object { $_.name -match $p } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  $names = ($assets | ForEach-Object { $_.name }) -join ', '
  throw "no asset matching '$Pattern' in ${Repo}: $names"
}

# ---------------------------------------------------------------- C++
$CppPrefix = Join-Path $Tools 'mingw64'
$gxx = Join-Path $CppPrefix 'bin\g++.exe'

if ((Test-Path $gxx) -and -not $Force) {
  Log "C++ toolchain already present: $gxx"
} else {
  Log 'Installing C++ toolchain (MinGW-w64)...'
  if (Test-Path $CppPrefix) { Remove-Item $CppPrefix -Recurse -Force }

  # The plain GCC build is what we want; the "llvm" variants bundle clang and are
  # several times larger for no benefit here.
  $asset = $null
  foreach ($pat in @(
      'x86_64-posix-seh-gcc-[\d.]+-mingw-w64ucrt-[\d.]+-r\d+\.zip$',
      'x86_64.*ucrt.*\.(zip|7z)$'
  )) {
    try { $asset = Github-Asset 'brechtsanders/winlibs_mingw' $pat 'posix-seh' 'llvm'; break }
    catch { Log "  pattern miss: $($_.Exception.Message)" }
  }
  if (-not $asset) {
    Log '  winlibs unavailable; falling back to w64devkit'
    $asset = Github-Asset 'skeeto/w64devkit' '(\.zip|\.7z)$' 'x64'
  }

  $archive = Join-Path $Cache $asset.name
  Ensure-Archive $asset.browser_download_url $archive 60000000

  $stage = Join-Path $Cache 'cpp-stage'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Extract-Zip $archive $stage

  $found = Find-File $stage 'g++.exe'
  if (-not $found) { throw "g++.exe not found inside $($archive)" }
  $binDir = $found.Directory.FullName
  $rootDir = Split-Path -Parent $binDir
  if ($rootDir -ne $stage) { Move-Item -Path $rootDir -Destination $CppPrefix -Force }
  else { Move-Item -Path $stage -Destination $CppPrefix -Force }

  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Log "C++ toolchain installed -> $CppPrefix"
}

if (-not (Test-Path $gxx)) { throw "C++ install failed: $gxx missing" }
$gver = (& $gxx --version 2>&1 | Select-Object -First 1)
Log "  g++ : $gver"

# ---------------------------------------------------------------- Java
$JavaPrefix = Join-Path $Tools 'jdk21'
$javac = Join-Path $JavaPrefix 'bin\javac.exe'

if ((Test-Path $javac) -and -not $Force) {
  Log "Java toolchain already present: $javac"
} else {
  Log 'Installing Java toolchain (Temurin 21 LTS)...'
  if (Test-Path $JavaPrefix) { Remove-Item $JavaPrefix -Recurse -Force }

  $url = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk'
  $archive = Join-Path $Cache 'temurin21-jdk.zip'
  Ensure-Archive $url $archive 80000000

  $stage = Join-Path $Cache 'java-stage'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Extract-Zip $archive $stage

  $found = Find-File $stage 'javac.exe'
  if (-not $found) { throw 'javac.exe not found inside the JDK archive' }
  $jdkRoot = Split-Path -Parent (Split-Path -Parent $found.FullName)
  Move-Item -Path $jdkRoot -Destination $JavaPrefix -Force

  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  Log "Java toolchain installed -> $JavaPrefix"
}

if (-not (Test-Path $javac)) { throw "Java install failed: $javac missing" }
$jver = (& $javac -version 2>&1 | Select-Object -First 1)
Log "  javac : $jver"

# ---------------------------------------------------------------- summary
Log ''
Log '=== toolchain summary ==='
Log ("  C++  : {0}  [{1}]" -f $gver, $gxx)
Log ("  Java : {0}  [{1}]" -f $jver, $javac)
Log '========================='

# ---------------------------------------------------------------- extras
# A fresh checkout needs the editor assets and the native launcher too, so setup
# leaves the app fully runnable rather than half-provisioned.
$vendorScript = Join-Path $PSScriptRoot 'vendor-assets.ps1'
if (Test-Path $vendorScript) { & $vendorScript }

$buildScript = Join-Path $PSScriptRoot 'build-jobrunner.ps1'
if (Test-Path $buildScript) { & $buildScript }

Log ''
Log 'Setup complete. Start the IDE with:  npm start'
