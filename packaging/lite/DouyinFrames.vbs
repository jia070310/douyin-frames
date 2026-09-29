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
    MsgBox "未找到 Node.js。请安装 Node 18+，或把便携 node.exe 放到 tools\node\", 16, "Douyin Frames"
    WScript.Quit 1
  End If
  nodeBin = "node"
End If

cmd = "cmd /c set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1&& set NODE_ENV=production&& set DOUYIN_FRAMES_ROOT=" & root & "&& " & nodeBin & " """ & root & "\src\desktop.js"""
sh.Run cmd, 0, False
