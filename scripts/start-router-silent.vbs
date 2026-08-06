# start-router-silent.vbs — 无黑窗启动路由（供开机自启快捷方式调用）
Set ws = CreateObject("WScript.Shell")
ps1 = Replace(WScript.ScriptFullName, "start-router-silent.vbs", "start-router.ps1")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
