# First-run setup, driven by the magpie plugin.
#
# Takes a machine that only has Codex installed and brings it to a working
# Dream Skin: the engine, a default theme, the desktop and Start-menu
# shortcuts, and a running injector. Every step is idempotent, so it doubles as
# a repair pass on a machine that is already set up.
#
# Prints one line of JSON.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EngineRoot,
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'),
  [string]$PreviewDir,
  [string]$ThemeLibrary,
  [string]$LauncherDir,
  # Written to settings.json so the shortcut path (which carries no arguments)
  # launches Codex on the same port the plugin watches.
  [int]$Port = 9335,
  [switch]$SkipShortcuts
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
  $Payload['ok'] = [bool]($Payload['ok'])
  try { ConvertTo-Json -InputObject $Payload -Compress -Depth 8 }
  catch { '{"ok":false,"error":"json-serialisation-failed"}' }
}

$steps = [ordered]@{}
try {
  $scripts = Join-Path $EngineRoot 'scripts'
  . (Join-Path $scripts 'common-windows.ps1')
  . (Join-Path $scripts 'theme-windows.ps1')

  # 1. Codex must exist. Everything else depends on it.
  try {
    $codex = Get-DreamSkinCodexInstall -ErrorAction Stop
    $steps.codex = "found"
  } catch {
    Write-Result @{ ok = $false; error = 'Codex (OpenAI.Codex) is not installed'; steps = $steps }
    exit 0
  }

  # 2. Engine present at the state root.
  $engineTarget = Join-Path $StateRoot 'engine'
  if (-not (Test-Path -LiteralPath (Join-Path $engineTarget 'scripts\injector.mjs'))) {
    if ([System.IO.Path]::GetFullPath($EngineRoot) -ne [System.IO.Path]::GetFullPath($engineTarget)) {
      New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
      Copy-Item -Path (Join-Path $EngineRoot '*') -Destination $engineTarget -Recurse -Force
      $steps.engine = 'installed'
      # the copy is now the live engine; re-run bootstrap against it so the
      # theme helpers come from the deployed tree
      $deployed = Join-Path $engineTarget 'scripts\bootstrap-dream-skin.ps1'
      if (Test-Path -LiteralPath $deployed) {
        $inner = & $deployed -EngineRoot $engineTarget -StateRoot $StateRoot -PreviewDir $PreviewDir `
          -ThemeLibrary $ThemeLibrary -LauncherDir $LauncherDir -Port $Port -SkipShortcuts:$SkipShortcuts
        Write-Output ($inner | Select-Object -Last 1)
        exit 0
      }
    } else {
      $steps.engine = 'already-live'
    }
  } else {
    $steps.engine = 'present'
  }

  # 3. Theme store, seeded from the bundled library.
  $paths = Initialize-DreamSkinThemeStore -SkillRoot $EngineRoot -StateRoot $StateRoot
  $steps.store = 'ready'

  $saved = @(Get-DreamSkinSavedThemes -StateRoot $StateRoot -SkipImageMetadata)
  if ($saved.Count -eq 0) {
    # Seed every bundled theme, not just one, so a fresh install opens with a
    # library to browse instead of a single card. Each source folder has to carry
    # its own theme.json; anything else in the directory is ignored.
    $library = $ThemeLibrary
    if (-not $library -or -not (Test-Path -LiteralPath $library -PathType Container)) {
      $library = Join-Path (Split-Path $EngineRoot -Parent) 'themes'
    }
    $seeded = 0
    if (Test-Path -LiteralPath $library -PathType Container) {
      foreach ($source in (Get-ChildItem -LiteralPath $library -Directory -ErrorAction SilentlyContinue)) {
        if (-not (Test-Path -LiteralPath (Join-Path $source.FullName 'theme.json') -PathType Leaf)) { continue }
        $id = $source.Name
        try {
          $declared = "$((Get-Content -LiteralPath (Join-Path $source.FullName 'theme.json') -Raw -Encoding UTF8 | ConvertFrom-Json).id)"
          if ($declared) { $id = $declared }
        } catch {}
        $target = Join-Path $paths.Saved $id
        if (Test-Path -LiteralPath $target) { continue }
        try {
          New-Item -ItemType Directory -Force -Path $target | Out-Null
          Copy-Item -Path (Join-Path $source.FullName '*') -Destination $target -Recurse -Force
          $seeded += 1
        } catch {}
      }
    }
    $steps.seededThemes = $seeded
    $saved = @(Get-DreamSkinSavedThemes -StateRoot $StateRoot -SkipImageMetadata)
  }

  # 4. Make sure something is active.
  $activeJson = Join-Path $paths.Active 'theme.json'
  if (-not (Test-Path -LiteralPath $activeJson) -and $saved.Count -gt 0) {
    $null = Use-DreamSkinSavedTheme -ThemeDirectory $saved[0].Path -StateRoot $StateRoot
    $steps.active = "$($saved[0].Id)"
  } elseif (Test-Path -LiteralPath $activeJson) {
    try { $steps.active = "$((Get-Content -LiteralPath $activeJson -Raw -Encoding UTF8 | ConvertFrom-Json).id)" } catch {}
  }

  # 5. Shortcuts, so the CDP flag is present from the first launch.
  # First deploy the launcher the shortcut will point at. Without it there is
  # nothing to start and the whole chain (debug port, injector, skin) is missing;
  # a fresh install used to end up with shortcuts to a file that did not exist.
  if ($LauncherDir -and (Test-Path -LiteralPath $LauncherDir -PathType Container)) {
    $deployedLaunchers = 0
    foreach ($name in @('launch-codex.ps1', 'launch-codex-hidden.vbs')) {
      $source = Join-Path $LauncherDir $name
      $target = Join-Path $StateRoot $name
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
      $same = $false
      if (Test-Path -LiteralPath $target -PathType Leaf) {
        try {
          $same = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq
                  (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        } catch {}
      }
      if (-not $same) {
        try { Copy-Item -LiteralPath $source -Destination $target -Force; $deployedLaunchers += 1 } catch {}
      }
    }
    $steps.launcher = $deployedLaunchers
  }
  # Record the port: the shortcut path starts launch-codex.ps1 with no arguments,
  # so this file is how it learns which port to open.
  try {
    $settingsFile = Join-Path $StateRoot 'settings.json'
    $settingsJson = @{ port = $Port } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($settingsFile, $settingsJson, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
  if (-not $SkipShortcuts) {
    $launcher = Join-Path $StateRoot 'launch-codex.ps1'
    $hidden = Join-Path $StateRoot 'launch-codex-hidden.vbs'
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
      # The icon has to hold up at every size Windows asks for. ChatGPT's own
      # tray artwork is a clean single-weight knot on transparency; the app icon
      # is a beveled badge with a white rim that turns to mush below 48px.
      $icon = Join-Path $StateRoot 'codex-tray.ico'
      if (-not (Test-Path -LiteralPath $icon)) {
        $iconSources = @()
        if ($LauncherDir) { $iconSources += (Join-Path $LauncherDir 'codex-tray.ico') }
        try {
          $iconSources += (Join-Path (Get-DreamSkinCodexInstall).InstallLocation 'app\resources\chatgpt-tray-light.ico')
        } catch {}
        foreach ($candidate in $iconSources) {
          if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            try { Copy-Item $candidate $icon -Force; break } catch {}
          }
        }
      }
      if (-not (Test-Path -LiteralPath $icon)) {
        # Last resort: whatever the executable itself carries.
        try {
          $exe = (Get-DreamSkinCodexInstall).Executable
          Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
          $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
          if ($ico) { $fs = [System.IO.File]::Create($icon); $ico.Save($fs); $fs.Close(); $ico.Dispose() }
        } catch {}
      }
      $shell = New-Object -ComObject WScript.Shell
      $made = 0
      foreach ($path in @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex.lnk'),
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Codex.lnk')
      )) {
        try {
          $shortcut = $shell.CreateShortcut($path)
          if (Test-Path -LiteralPath $hidden -PathType Leaf) {
            $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
            $shortcut.Arguments = "`"$hidden`""
          } else {
            $shortcut.TargetPath = 'powershell.exe'
            $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
          }
          $shortcut.WorkingDirectory = $StateRoot
          if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
          $shortcut.Description = 'Codex with the Dream Skin CDP endpoint'
          $shortcut.Save()
          $made += 1
        } catch {}
      }
      $steps.shortcuts = $made
    } else {
      $steps.shortcuts = 'launcher-missing'
    }
  }

  # 6. Previews for the page.
  if ($PreviewDir) {
    if (-not (Test-Path -LiteralPath $PreviewDir)) { New-Item -ItemType Directory -Force -Path $PreviewDir | Out-Null }
  }

  Write-Result @{
    ok        = $true
    steps     = $steps
    themes    = $saved.Count
    stateRoot = $StateRoot
  }
} catch {
  Write-Result @{ ok = $false; error = "$($_.Exception.Message)"; steps = $steps }
}
