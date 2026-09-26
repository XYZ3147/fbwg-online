# Updates this extension folder to the latest release on GitHub.
# Run it with Update.cmd (double-click). The extension notices the new files
# and reloads itself once no game is being hosted or joined.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'XYZ3147/fbwg-online'
$ZipUrl = "https://github.com/$Repo/releases/latest/download/fbwg-online.zip"
$ExpectedName = 'Fireboy & Watergirl Online'
$Folder = $PSScriptRoot

function Fail($msg) {
  Write-Host ''
  Write-Host "Update failed: $msg" -ForegroundColor Red
  exit 1
}

Write-Host 'Fireboy & Watergirl Online updater' -ForegroundColor Cyan
Write-Host "Folder: $Folder"

if (Test-Path (Join-Path $Folder '.git')) {
  Fail 'this is the development copy (it has a .git folder). Update it with git instead.'
}

$manifestPath = Join-Path $Folder 'manifest.json'
if (-not (Test-Path $manifestPath)) { Fail 'manifest.json not found. Run Update.cmd from inside the extension folder.' }
$current = (Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
if ($current.name -ne $ExpectedName) { Fail "this folder holds '$($current.name)', not $ExpectedName." }
Write-Host "Installed version: $($current.version)"

$work = Join-Path ([IO.Path]::GetTempPath()) ("fbwg-update-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $zip = Join-Path $work 'fbwg-online.zip'
  Write-Host 'Downloading the latest version from GitHub...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try { Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing } catch { Fail "could not download it ($($_.Exception.Message))." }

  $unpacked = Join-Path $work 'files'
  try { Expand-Archive -Path $zip -DestinationPath $unpacked } catch { Fail 'the download was not a valid zip file.' }

  $newManifestPath = Join-Path $unpacked 'manifest.json'
  if (-not (Test-Path $newManifestPath)) { Fail 'the download has no manifest.json.' }
  $new = (Get-Content $newManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  if ($new.name -ne $ExpectedName) { Fail 'the download is not this extension.' }

  if ([version]$new.version -le [version]$current.version) {
    Write-Host ''
    Write-Host "You already have the latest version ($($current.version))." -ForegroundColor Green
    exit 0
  }

  Write-Host "Installing version $($new.version)..."
  Copy-Item -Path (Join-Path $unpacked '*') -Destination $Folder -Recurse -Force

  Write-Host ''
  Write-Host "Updated to version $($new.version)." -ForegroundColor Green
  Write-Host 'The extension reloads itself within a minute, or as soon as your current game ends.'
}
finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}
