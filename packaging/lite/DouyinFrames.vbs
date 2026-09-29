' 无控制台闪窗启动 Douyin Frames（最轻桌面入口）
Option Explicit
Dim sh, fso, root, cmd, nodeBin
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

nodeBin = ""
If fso.FileExists(root & "\tools\node\node.exe") Then
  nodeBin = """" & root & "\tools\node\node.exe"""
Else
  On Error Resume Next
  Dim which
  which = sh.Exec("cmd /c where node").StdOut.ReadAll
  On Error Goto 0
  If InStr(which, "node") = 0 Then
    MsgBox "未找到 Node.js。" & vbCrLf & vbCrLf & _
      "手动下载：" & vbCrLf & "https://nodejs.org/zh-cn/download/" & vbCrLf & vbCrLf & _
      "便携 zip：" & vbCrLf & "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip" & vbCrLf & vbCrLf & _
      "解压后把 node.exe 放到 tools\node\", 16, "Douyin Frames"
    WScript.Quit 1
  End If
  nodeBin = "node"
End If

cmd = "cmd /c set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1&& set NODE_ENV=production&& set DOUYIN_FRAMES_ROOT=" & root & "&& " & nodeBin & " """ & root & "\src\desktop.js"""
sh.Run cmd, 0, False
