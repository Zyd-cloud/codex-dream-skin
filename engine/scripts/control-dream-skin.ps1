# Single entry point the magpie plugin calls. Every action prints exactly one
# line of JSON on stdout and never throws, so the plugin host can parse it
# without special-casing failures.
#
#   status                       current state + theme list + preview paths
#   list                         the theme list alone
#   switch  -ThemeId <id>        apply a saved theme
#   pause                        restore Codex's original look
#   resume                       apply the active theme again
#   bootstrap                    first-run setup (engine, themes, shortcuts)
#   refresh-previews             regenerate page/previews/*.jpg
#   prune                        delete archived backgrounds nobody references
#   install -ThemeId <id> -SourceZip|-SourceDir <path>   import a theme

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$ThemeId,
  [string]$SourceZip,
  [string]$SourceDir,
  [string]$PreviewDir,
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'),
  [string]$EngineRoot,
  # Same CDP port the plugin decided; the default matches it for a manual run.
  [int]$Port = 9335,
  # Fold a full status read into this action's reply, so the caller does not need
  # a second PowerShell run (~1.6 s) just to refresh what it shows the page.
  [switch]$WithStatus
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 writes UTF-8 JSON with the console's codepage by default, which
# turns any non-ASCII theme name into mojibake for the caller (Node reads it as
# UTF-8). Pin the output encoding before anything is printed.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {}
function Write-Result {
  param([hashtable]$Payload)
  $Payload['action'] = $Action
  $Payload['ok'] = [bool]($Payload['ok'])
  # Only for the actions that changed something: 'status' is the status, and a
  # failed action's caller wants the error, not a fresh snapshot.
  if ($WithStatus -and $Action -ne 'status' -and $Payload['ok']) {
    try { $Payload['status'] = Get-StatusPayload } catch {}
  }
  try {
    ConvertTo-Json -InputObject $Payload -Compress -Depth 8
  } catch {
    '{"ok":false,"error":"json-serialisation-failed"}'
  }
}

# Throw rather than `exit 0`: the outer catch turns this into the same JSON, and
# a throw still unwinds through the operation lock's finally so the lock is
# released. `exit` would abandon it (recoverable, but noisy).
function Fail {
  param([string]$Message)
  throw $Message
}

try {
  if (-not $EngineRoot) { $EngineRoot = Split-Path $PSScriptRoot -Parent }
  $scripts = Join-Path $EngineRoot 'scripts'
  . (Join-Path $scripts 'common-windows.ps1')
  . (Join-Path $scripts 'theme-windows.ps1')

  $paths = Get-DreamSkinThemePaths -StateRoot $StateRoot
  $activeTheme = Join-Path $paths.Active 'theme.json'

  function Get-InjectorProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*injector.mjs*' })
  }

  function Get-CurrentBrowserId {
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
      $m = [regex]::Match(($r.Content | ConvertFrom-Json).webSocketDebuggerUrl, '/browser/([0-9a-fA-F-]{36})$')
      if ($m.Success) { return $m.Groups[1].Value }
    } catch {}
    return $null
  }

  function Get-ThemeList {
    $items = @()
    foreach ($theme in (Get-DreamSkinSavedThemes -StateRoot $StateRoot -SkipImageMetadata)) {
      $entry = [ordered]@{
        id         = "$($theme.Id)"
        name       = "$($theme.Name)"
        directory  = "$($theme.Path)"
        appearance = 'auto'
        taskMode   = 'ambient'
        image      = ''
        preview    = ''
      }
      try {
        $tj = Join-Path $theme.Path 'theme.json'
        if (Test-Path -LiteralPath $tj) {
          $raw = Get-Content -LiteralPath $tj -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($raw.image) { $entry.image = "$($raw.image)" }
          if ($raw.appearance) { $entry.appearance = "$($raw.appearance)" }
          if ($raw.art -and $raw.art.taskMode) { $entry.taskMode = "$($raw.art.taskMode)" }
          if ($raw.colors) {
            $entry.colors = [ordered]@{
              background = "$($raw.colors.background)"
              panel      = "$($raw.colors.panel)"
              accent     = "$($raw.colors.accent)"
              text       = "$($raw.colors.text)"
              line       = "$($raw.colors.line)"
            }
          }
        }
      } catch {}
      if ($PreviewDir -and $entry.id) {
        $candidate = Join-Path $PreviewDir ("{0}.jpg" -f $entry.id)
        if (Test-Path -LiteralPath $candidate) { $entry.preview = "$($entry.id).jpg" }
      }
      $items += [pscustomobject]$entry
    }
    return @($items)
  }

  function Get-ActiveThemeId {
    if (-not (Test-Path -LiteralPath $activeTheme)) { return '' }
    try { return "$((Get-Content -LiteralPath $activeTheme -Raw -Encoding UTF8 | ConvertFrom-Json).id)" } catch { return '' }
  }

  function Convert-ImageWithGdiPlus {
    param(
      [Parameter(Mandatory = $true)][string]$Source,
      [Parameter(Mandatory = $true)][string]$Target,
      [int]$Width = 480,
      $Codec
    )
    $img = [System.Drawing.Image]::FromFile($Source)
    try {
      $h = [int][math]::Round($img.Height * ($Width / $img.Width))
      if ($h -lt 1) { $h = 1 }
      $bmp = New-Object System.Drawing.Bitmap($Width, $h)
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g.DrawImage($img, 0, 0, $Width, $h)
        } finally { $g.Dispose() }
        $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
          [System.Drawing.Imaging.Encoder]::Quality, [long]82)
        $bmp.Save($Target, $Codec, $params)
      } finally { $bmp.Dispose() }
    } finally { $img.Dispose() }
  }

  # WIC decodes what GDI+ cannot: WebP, and anything else a Windows codec
  # package adds. WPF's encoder writes the JPEG out.
  function Convert-ImageWithWic {
    param(
      [Parameter(Mandatory = $true)][string]$Source,
      [Parameter(Mandatory = $true)][string]$Target,
      [int]$Width = 480
    )
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
      (New-Object System.Uri($Source)), 'None', 'OnLoad')
    $frame = $decoder.Frames[0]
    if (-not $frame -or $frame.PixelWidth -le 0) { throw 'WIC returned no frame' }

    $scale = [math]::Min(1.0, $Width / $frame.PixelWidth)
    $transform = New-Object System.Windows.Media.ScaleTransform($scale, $scale)
    $scaled = New-Object System.Windows.Media.Imaging.TransformedBitmap($frame, $transform)

    $encoder = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
    $encoder.QualityLevel = 82
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($scaled))
    $stream = [System.IO.File]::Create($Target)
    try { $encoder.Save($stream) } finally { $stream.Close(); $stream.Dispose() }
  }

  # Every theme switch archives a fresh copy of the background under images/,
  # and nothing ever removed the old ones: 115 files, 189 MB, of which one was
  # still referenced. Timestamps cannot be trusted here (the copies inherit a
  # bogus LastWriteTime from their source), so age comes from CreationTime.
  function Invoke-ImagePrune {
    $result = [ordered]@{ removed = 0; freedBytes = 0; kept = 0 }
    $imagesDir = Join-Path $StateRoot 'images'
    if (-not (Test-Path -LiteralPath $imagesDir -PathType Container)) { return $result }

    $referenced = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($dir in @((Join-Path $StateRoot 'active-theme'), (Join-Path $StateRoot 'themes'))) {
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
      foreach ($themeJson in (Get-ChildItem -LiteralPath $dir -Recurse -Filter 'theme.json' -ErrorAction SilentlyContinue)) {
        try {
          $raw = Get-Content -LiteralPath $themeJson.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($raw.image) { [void]$referenced.Add("$($raw.image)") }
        } catch {}
      }
    }
    # dream-reference.jpg is the engine's own archive, not a theme's copy.
    [void]$referenced.Add('dream-reference.jpg')

    # Nothing resolved means every read failed. Pruning on that would delete the
    # background of the theme currently on screen, so do nothing instead.
    $current = Join-Path $StateRoot 'active-theme\theme.json'
    if (-not (Test-Path -LiteralPath $current -PathType Leaf)) { return $result }

    $cutoff = (Get-Date).AddMinutes(-30)
    foreach ($file in (Get-ChildItem -LiteralPath $imagesDir -File -ErrorAction SilentlyContinue)) {
      if ($referenced.Contains($file.Name)) { $result.kept += 1; continue }
      if ($file.CreationTime -gt $cutoff) { $result.kept += 1; continue }
      try {
        $size = $file.Length
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
        $result.removed += 1
        $result.freedBytes += $size
      } catch {}
    }
    return $result
  }

  function Update-Previews {
    param([string]$Directory)
    $result = [ordered]@{ generated = 0; skipped = 0; errors = @() }
    if (-not $Directory) { $result.errors += 'previewDir is empty'; return $result }
    if (-not (Test-Path -LiteralPath $Directory)) {
      New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    }
    try {
      Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    } catch {
      $result.errors += "System.Drawing unavailable: $($_.Exception.Message)"
      return $result
    }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if (-not $codec) { $result.errors += 'no JPEG encoder available'; return $result }

    # Get-DreamSkinSavedThemes yields Id/Name/Path. Using anything else here
    # silently produced no previews at all.
    foreach ($theme in (Get-DreamSkinSavedThemes -StateRoot $StateRoot -SkipImageMetadata)) {
      try {
        $tj = Join-Path $theme.Path 'theme.json'
        if (-not (Test-Path -LiteralPath $tj)) { $result.errors += "$($theme.Id): no theme.json"; continue }
        $raw = Get-Content -LiteralPath $tj -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $raw.image) { $result.errors += "$($theme.Id): no image field"; continue }
        $src = Join-Path $theme.Path "$($raw.image)"
        if (-not (Test-Path -LiteralPath $src)) { $result.errors += "$($theme.Id): image file missing"; continue }

        $out = Join-Path $Directory ("{0}.jpg" -f $theme.Id)
        if ((Test-Path -LiteralPath $out) -and
            ((Get-Item -LiteralPath $out).LastWriteTime -ge (Get-Item -LiteralPath $src).LastWriteTime)) {
          $result.skipped += 1
          continue
        }

        # GDI+ cannot open WebP ("Out of memory"), and market themes ship
        # `background.webp`. WIC can, through the WebpImageExtension that ships
        # with Windows, so it is the fallback rather than the first choice.
        $width = 480
        try {
          Convert-ImageWithGdiPlus -Source $src -Target $out -Width $width -Codec $codec
        } catch {
          Convert-ImageWithWic -Source $src -Target $out -Width $width
        }
        $result.generated += 1
      } catch {
        $result.errors += ("{0}: {1}" -f $theme.Id, $_.Exception.Message)
      }
    }
    return $result
  }

  # Anything that writes the theme store takes the engine's operation lock, so a
  # switch cannot read a theme while an install is still copying it in. The
  # read-only actions stay unlocked: the page polls status every couple of
  # seconds and must not be refused because some other action is running.
  # ensure-injector uses its own mutex, so this does not fight the supervisor.
  $mutating = @('switch', 'pause', 'resume', 'install', 'prune', 'refresh-previews')

  $operationLock = $null
  if ($mutating -contains $Action) {
    $operationLock = Enter-DreamSkinOperationLock
  }

  # Building the status costs about 1.6 s on top of whatever action ran -- the CIM
  # query, the CDP probe and a theme.json read for every theme. The caller needs a
  # fresh state right after a mutating action anyway, so -WithStatus folds that
  # read into the same PowerShell run instead of paying process startup twice.
  function Get-StatusPayload {
    $injectors = @(Get-InjectorProcesses)
    $browserId = Get-CurrentBrowserId
    $injectorBrowserId = $null
    if ($injectors.Count) {
      $m = [regex]::Match($injectors[0].CommandLine, '--browser-id\s+([0-9a-fA-F-]{36})')
      if ($m.Success) { $injectorBrowserId = $m.Groups[1].Value }
    }
    $codex = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
    return [ordered]@{
      ok            = $true
      stateRoot     = $StateRoot
      paused        = (Test-DreamSkinPaused -StateRoot $StateRoot)
      active        = (Get-ActiveThemeId)
      themes        = @(Get-ThemeList)
      injectorCount = $injectors.Count
      injectorFresh = [bool]($browserId -and $injectorBrowserId -and ($browserId -eq $injectorBrowserId))
      codexRunning  = ($codex.Count -gt 0)
      cdpUp         = [bool]$browserId
      previewDir    = $PreviewDir
    }
  }

  try {
    switch ($Action) {
    'status' {
      Write-Result (Get-StatusPayload)
    }
    'list' {
      Write-Result @{ ok = $true; themes = @(Get-ThemeList) }
    }
    'switch' {
      if (-not $ThemeId) { Fail 'themeId is required' }
      $dir = Join-Path $paths.Saved $ThemeId
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Fail "theme not found: $ThemeId" }
      $result = Use-DreamSkinSavedTheme -ThemeDirectory $dir -StateRoot $StateRoot
      Set-DreamSkinPaused -Paused $false -StateRoot $StateRoot | Out-Null
      Write-Result @{ ok = $true; active = "$($result.Theme.id)"; paused = $false }
    }
    'pause' {
      Set-DreamSkinPaused -Paused $true -StateRoot $StateRoot | Out-Null
      Write-Result @{ ok = $true; paused = $true; active = (Get-ActiveThemeId) }
    }
    'resume' {
      Set-DreamSkinPaused -Paused $false -StateRoot $StateRoot | Out-Null
      Write-Result @{ ok = $true; paused = $false; active = (Get-ActiveThemeId) }
    }
    'refresh-previews' {
      $preview = Update-Previews -Directory $PreviewDir
      Write-Result @{ ok = $true; generated = $preview.generated; skipped = $preview.skipped; errors = @($preview.errors) }
    }
    'prune' {
      $pruned = Invoke-ImagePrune
      Write-Result @{
        ok         = $true
        removed    = $pruned.removed
        kept       = $pruned.kept
        freedBytes = $pruned.freedBytes
      }
    }
    'install' {
      if (-not $ThemeId) { Fail 'themeId is required' }
      $target = Join-Path $paths.Saved $ThemeId
      if (Test-Path -LiteralPath $target) { Fail "theme already exists: $ThemeId" }
      if (-not ($SourceDir -and (Test-Path -LiteralPath $SourceDir -PathType Container)) -and
          -not ($SourceZip -and (Test-Path -LiteralPath $SourceZip -PathType Leaf))) {
        Fail 'sourceZip or sourceDir is required'
      }

      # A half-copied or invalid package must not leave its folder behind: the
      # theme would sit in the library as permanently broken, and re-installing
      # it would be refused with "theme already exists" until someone deleted the
      # directory by hand.
      try {
        if ($SourceDir -and (Test-Path -LiteralPath $SourceDir -PathType Container)) {
          New-Item -ItemType Directory -Force -Path $target | Out-Null
          Copy-Item -Path (Join-Path $SourceDir '*') -Destination $target -Recurse -Force
        } else {
          $tmp = Join-Path $env:TEMP ("dreamskin-import-" + [guid]::NewGuid().ToString('N'))
          try {
            Expand-Archive -LiteralPath $SourceZip -DestinationPath $tmp -Force
            # tolerate a single top-level folder inside the zip
            $entries = @(Get-ChildItem $tmp -Force)
            $root = $tmp
            if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $root = $entries[0].FullName }
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            Copy-Item -Path (Join-Path $root '*') -Destination $target -Recurse -Force
          } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
          }
        }
        $null = Read-DreamSkinTheme -ThemeDirectory $target -SkipImageMetadata
      } catch {
        if (Test-Path -LiteralPath $target) {
          Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
      }

      if ($PreviewDir) { $null = Update-Previews -Directory $PreviewDir }
      Write-Result @{ ok = $true; installed = $ThemeId }
    }
    'bootstrap' {
      $script = Join-Path $scripts 'bootstrap-dream-skin.ps1'
      if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { Fail 'bootstrap script missing' }
      $json = & $script -EngineRoot $EngineRoot -StateRoot $StateRoot -PreviewDir $PreviewDir
      Write-Output ($json | Select-Object -Last 1)
      exit 0
    }
    default { Fail "unknown action: $Action" }
    }
  } finally {
    if ($operationLock) { Exit-DreamSkinOperationLock -Mutex $operationLock }
  }
} catch {
  Write-Result @{ ok = $false; error = "$($_.Exception.Message)" }
}
