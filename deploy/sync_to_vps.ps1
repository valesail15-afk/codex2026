param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Password,
  [int]$Port = 22,
  [string]$RemoteDir = "/opt/afk",
  [switch]$SkipBuild,
  [switch]$SkipRuntimeDb
)

$scriptPath = Join-Path $PSScriptRoot "sync_to_vps.py"
if (!(Test-Path $scriptPath)) {
  throw "未找到脚本: $scriptPath"
}

$args = @(
  $scriptPath,
  "--host", $ServerHost,
  "--user", $User,
  "--password", $Password,
  "--port", "$Port",
  "--remote-dir", $RemoteDir
)

if ($SkipBuild) {
  $args += "--skip-build"
}

if ($SkipRuntimeDb) {
  $args += "--skip-runtime-db"
}

python @args
