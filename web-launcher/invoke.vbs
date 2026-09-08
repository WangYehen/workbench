Option Explicit

Dim shell, fso, scriptDir, installRoot, currentPath, content, regex, matches
Dim version, nodeExe, launcher, action, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
installRoot = fso.GetParentFolderName(scriptDir)
currentPath = fso.BuildPath(installRoot, "current.json")

If Not fso.FileExists(currentPath) Then
  MsgBox "没有找到已安装的工作台版本，请重新运行安装包。", vbCritical, "个人AI工作台"
  WScript.Quit 1
End If

content = fso.OpenTextFile(currentPath, 1, False).ReadAll
Set regex = New RegExp
regex.Pattern = """version""\s*:\s*""([^""]+)"""
regex.IgnoreCase = True
Set matches = regex.Execute(content)
If matches.Count = 0 Then
  MsgBox "工作台版本信息损坏，请重新运行安装包。", vbCritical, "个人AI工作台"
  WScript.Quit 1
End If

version = matches(0).SubMatches(0)
nodeExe = fso.BuildPath(installRoot, "versions\" & version & "\runtime\node.exe")
launcher = fso.BuildPath(scriptDir, "launcher.mjs")
If Not fso.FileExists(nodeExe) Then
  MsgBox "工作台运行文件不完整，请重新运行安装包。", vbCritical, "个人AI工作台"
  WScript.Quit 1
End If

action = "start"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)
command = """" & nodeExe & """ """ & launcher & """ " & action
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
