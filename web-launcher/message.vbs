Option Explicit

Dim fso, message, title
Set fso = CreateObject("Scripting.FileSystemObject")
message = "工作台启动失败。"
title = "团队每日工作台"
If WScript.Arguments.Count > 0 Then
  If fso.FileExists(WScript.Arguments(0)) Then message = fso.OpenTextFile(WScript.Arguments(0), 1, False).ReadAll
End If
If WScript.Arguments.Count > 1 Then title = WScript.Arguments(1)
MsgBox message, vbCritical, title
