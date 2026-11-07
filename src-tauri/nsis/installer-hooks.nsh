; 卸载器勾选「删除应用程序数据」时，Tauri 默认只清理
; %APPDATA%\app.homeledger.desktop 和 %LOCALAPPDATA%\app.homeledger.desktop。
;
; HomeLedger 的内置服务数据实际在 %APPDATA%\HomeLedger：SQLite、附件、备份、
; 日志都在那里，不在 bundle id 目录下。所以默认的勾选项清不干净，这里补一刀。
; 只在用户主动勾选、且不是覆盖升级时执行。
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\HomeLedger"
    RmDir /r "$LOCALAPPDATA\HomeLedger"
  ${EndIf}
!macroend
