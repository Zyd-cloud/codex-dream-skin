' Hidden launcher for Codex with the Dream Skin CDP endpoint.
'
' WScript has no console window, and Run(..., 0, False) keeps the child hidden
' too, so double-clicking the shortcut produces no flash at all. PowerShell with
' -WindowStyle Hidden still shows a brief console, which is why this wrapper
' exists.
'
' The real work (resolving the installed Codex package and starting it with
' --remote-debugging-port) lives in launch-codex.ps1.

Option Explicit

Dim shell, fileSystem, scriptDir, ps1, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

' Resolve the sibling PowerShell script relative to this file, so the whole
' CodexDreamSkin folder can be moved without editing anything.
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
ps1 = fileSystem.BuildPath(scriptDir, "launch-codex.ps1")

If Not fileSystem.FileExists(ps1) Then
  shell.Popup "launch-codex.ps1 was not found next to this launcher.", _
    10, "Codex Dream Skin", 48
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """"

' intWindow 0 = hidden, bWaitOnReturn False = the wrapper exits immediately.
shell.Run command, 0, False
