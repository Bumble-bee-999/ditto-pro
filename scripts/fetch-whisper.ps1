# Downloads the offline speech engine (whisper.cpp) and a speech model into ..\whisper so the installer can bundle them.
# Safe to re-run; skips what is already there. Failure only disables caption generation, never the build.
$ErrorActionPreference = 'Stop'
$dest = Join-Path $PSScriptRoot '..\whisper'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  $have = Get-ChildItem -Path $dest -Recurse -Include 'whisper-cli.exe','main.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $have) {
    Write-Host 'Downloading whisper.cpp engine...'
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' -Headers @{ 'User-Agent' = 'ditto-pro-build' }
    $asset = $rel.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
    if (-not $asset) { throw 'whisper-bin-x64.zip was not found in the latest whisper.cpp release (the project may have renamed it).' }
    $zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force
  }
  $model = Join-Path $dest 'ggml-base.en.bin'
  if (-not (Get-ChildItem -Path $dest -Filter 'ggml-*.bin' -ErrorAction SilentlyContinue)) {
    Write-Host 'Downloading speech model (ggml-base.en.bin, ~140 MB)...'
    Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' -OutFile $model -UseBasicParsing
  }
  Write-Host 'Speech engine ready.'
} catch {
  Write-Warning ('Could not fetch the speech engine: ' + $_.Exception.Message)
  Write-Warning 'The app will still build; "Generate captions from speech" will report that the engine is missing.'
}
exit 0
