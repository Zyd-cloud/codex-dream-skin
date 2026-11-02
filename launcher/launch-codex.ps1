# Codex launcher.
#
# Modes:
#   native  - start Codex exactly as the Start menu does, no extra flags.
#             Used to isolate whether Codex itself objects to the debugging port.
#   skin    - start Codex with --remote-debugging-port so the Dream Skin injector
#             can attach. This is the normal mode.
#
# The mode is chosen by the presence of a `native.flag` file next to this script,
# so switching needs no edit and no shortcut change.
#
# Why the wait-for-exit loop: Codex is a Chromium/Electron app holding an
# exclusive lock on its user-data-dir. Closing it and immediately starting it
# again made the new instance lose that race and exit within seconds with no
# error at all -- no crash dump, no Windows event, and Sentry reporting
# "status: ok, errors: 0". That is the "closes and never comes back" report.
# Waiting for every ChatGPT.exe to disappear first removes the race.

param(
  # The CDP port the skin's injector will look for. Bootstrap and the supervisor
  # pass the plugin's own value; the default matches it for a manual run.
  [int]$Port = 9335
)

$ErrorActionPreference = 'Stop'

# Started from the shortcut there is no -Port on the command line, so take it
# from the settings file bootstrap wrote. That keeps the port defined in one
# place while still letting the supervisor override it explicitly.
if (-not $PSBoundParameters.ContainsKey('Port')) {
  try {
    $settingsPath = Join-Path $PSScriptRoot 'settings.json'
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
      $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($settings.port) { $Port = [int]$settings.port }
    }
  } catch {}
}

$nativeFlag = Join-Path $PSScriptRoot 'native.flag'
$native = Test-Path -LiteralPath $nativeFlag -PathType Leaf
$launchLog = Join-Path $PSScriptRoot 'launch.log'

function Write-LaunchLog {
  param([string]$Message)
  try {
    $stamp = (Get-Date).ToString('o')
    Add-Content -LiteralPath $launchLog -Value "$stamp $Message" -ErrorAction Stop
  } catch {}
}

# Wait until no ChatGPT.exe is left. A Chromium app can take a few seconds to
# release its profile lock, and starting inside that window is what failed.
#
# But a Codex that already has a visible window is not "still exiting" -- it is
# simply already open, and the click should raise it instead of waiting 30s.
Add-Type -Namespace Win32Window -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@ -ErrorAction SilentlyContinue

function Show-ExistingCodex {
  foreach ($p in (Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -ne 0) {
      [Win32Window.Api]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
      [Win32Window.Api]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
      return $true
    }
  }
  return $false
}

if (Show-ExistingCodex) {
  Write-LaunchLog "Codex already has a window; raised it and stopped"
  exit 0
}

$waitSeconds = 30
$waitStart = Get-Date
$deadline = $waitStart.AddSeconds($waitSeconds)
$loggedWait = $false
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { break }
  if (-not $loggedWait) {
    Write-LaunchLog "previous Codex still exiting ($($procs.Count) processes, no window yet); waiting"
    $loggedWait = $true
  }
  Start-Sleep -Milliseconds 400
}
if ($loggedWait) {
  $waited = [math]::Round(((Get-Date) - $waitStart).TotalSeconds, 1)
  Write-LaunchLog "waited ${waited}s for the previous Codex to exit"
}

$stillRunning = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
if ($stillRunning.Count -gt 0) {
  # Something (the user, or the plugin's delayed relaunch) already has Codex up.
  # Starting another instance would only fight it for the profile lock, so treat
  # this click as "bring it to the front" and stop here.
  Write-LaunchLog "Codex is already running after ${waitSeconds}s wait; not starting a second instance"
  exit 0
}

$exe = $null
try {
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($package -and $package.InstallLocation) {
    $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $exe = $candidate }
  }
} catch {}

if (-not $exe) {
  try {
    $resolved = Resolve-Path 'C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' -ErrorAction Stop
    $exe = $resolved.Path
  } catch {}
}

if (-not $exe) {
  Write-LaunchLog "Codex executable not found"
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Codex (ChatGPT.exe) was not found.`nStart Codex once from the Start menu so Windows registers the package, then try again.",
    'Codex',
    'OK',
    'Warning') | Out-Null
  exit 1
}

# Codex must be started through its package identity, not by running the exe.
#
# The difference is visible on the taskbar: a package activation carries an
# AppUserModelID, so Windows draws the app's registered logo -- the white knot
# the tray uses. Running ChatGPT.exe directly produces a bare process, and the
# taskbar falls back to the icon embedded in the executable, which is the
# beveled blue badge. Same app, two different icons, purely from how it started.
$activationTypeReady = $false
try {
  if (-not ('CodexPackageActivation' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] int options, [Out] out uint processId);
  int ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray, [In] string verb, [Out] out uint processId);
  int ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
}
public class CodexPackageActivation {
  public static uint Activate(string appUserModelId, string arguments) {
    var t = Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"));
    var mgr = (IApplicationActivationManager)System.Activator.CreateInstance(t);
    uint processId;
    int hr = mgr.ActivateApplication(appUserModelId, arguments ?? "", 0, out processId);
    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    return processId;
  }
}
'@ -ErrorAction Stop
  }
  $activationTypeReady = $true
} catch {
  Write-LaunchLog "package activation helper unavailable: $($_.Exception.Message)"
}

$appUserModelId = $null
try {
  $family = $package.PackageFamilyName
  $applicationId = 'App'
  $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    $entry = $manifest.Package.Applications.Application |
      Where-Object { $_.Executable -like '*ChatGPT.exe' } |
      Select-Object -First 1
    if ($entry -and $entry.Id) { $applicationId = "$($entry.Id)" }
  }
  if ($family) { $appUserModelId = "$family!$applicationId" }
} catch {
  Write-LaunchLog "could not resolve the package identity: $($_.Exception.Message)"
}

function Start-CodexPackage {
  param([string]$Arguments)
  if ($activationTypeReady -and $appUserModelId) {
    try {
      $processId = [CodexPackageActivation]::Activate($appUserModelId, $Arguments)
      Write-LaunchLog "activated $appUserModelId (pid $processId)"
      return $true
    } catch {
      Write-LaunchLog "package activation failed: $($_.Exception.Message)"
    }
  }
  return $false
}

if ($native) {
  Write-LaunchLog "launching native (no flags)"
  if (-not (Start-CodexPackage -Arguments '')) {
    Write-LaunchLog "falling back to a direct start; the taskbar icon will be the one in the exe"
    Start-Process -FilePath $exe
  }
} else {
  # The GPU flags are there because this machine raises system-level faults
  # (BlueScreen / LiveKernelEvent) several times a day on an Intel Arc driver.
  # Software rendering keeps Codex off that path.
  $gpuHardware = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'gpu-hardware.flag') -PathType Leaf

  $cdpArgs = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port")
  if (-not $gpuHardware) {
    $cdpArgs += @('--disable-gpu', '--use-angle=swiftshader')
  }

  Write-LaunchLog "launching with CDP (gpu=$(if ($gpuHardware) { 'hardware' } else { 'software' }))"
  if (-not (Start-CodexPackage -Arguments ($cdpArgs -join ' '))) {
    Write-LaunchLog "falling back to a direct start; the taskbar icon will be the one in the exe"
    Start-Process -FilePath $exe -ArgumentList $cdpArgs
  }
}
