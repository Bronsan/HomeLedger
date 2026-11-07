//! 系统日历写入。
//!
//! 「维护」页要把任务和周期计划直接写进用户设备的日历（不是生成 .ics 再
//! 手动导入）。两条实现路径，按平台分发：
//!
//! * **Android** —— 通过内嵌的 Kotlin 插件（`native/android/CalendarPlugin.kt`，
//!   构建时校正进 gen 工程）用 READ/WRITE_CALENDAR 运行时权限写
//!   CalendarProvider。首次写入会弹系统授权框，授权流程在 Kotlin 侧闭环。
//! * **桌面** —— Windows 没有公开的系统日历 API。装了 Outlook 时通过 COM
//!   自动化写进默认日历（按任务名去重）；没装则返回明确错误，前端回退到
//!   现有的 .ics 导出。
//!
//! 命令注册在主 invoke_handler 里（同 app_info 等），不需要 capability 条目；
//! 插件本体只负责在 Android 上把 Kotlin 侧加载进来并管理它的句柄。

use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// 事件开始的 epoch 毫秒（Android 用）。
    pub start_ms: i64,
    /// 事件时长毫秒，0 表示用默认（30 分钟）。
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub all_day: bool,
    /// 周期计划：每 N 天循环；None / 0 表示一次性任务。
    #[serde(default)]
    pub interval_days: Option<i64>,
    /// 提醒提前量（分钟），0 表示不提醒。
    #[serde(default)]
    pub reminder_minutes: i64,
    /// 桌面 Outlook 用：开始时间的本地表示 "yyyy-MM-dd HH:mm"。
    #[serde(default)]
    pub start_local: String,
}

/// Kotlin 侧插件句柄。只在 Android 上有值；桌面端没有移动插件可挂，
/// R 依然要占住类型位（命令里按 CalendarBridge<Wry> 取状态）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct CalendarBridge<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<R>,
}

#[cfg(target_os = "android")]
impl<R: Runtime> CalendarBridge<R> {
    fn run<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: impl Serialize,
    ) -> Result<T, String> {
        self.handle
            .run_mobile_plugin(command, payload)
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("calendar")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("app.homeledger.desktop", "CalendarPlugin")?;
                app.manage(CalendarBridge { handle });
            }
            // 桌面端没有要注册的东西；参数以 _ 开头仍可在 cfg 块里使用。
            #[cfg(not(target_os = "android"))]
            {
                let _ = app;
                let _ = api;
            }
            Ok(())
        })
        .build()
}
/// 写入/更新一条日历事件。按 task_id 幂等：已存在则更新，所以重复点
/// 「写入系统日历」不会堆积重复事件。
#[tauri::command]
pub fn calendar_write_event(app: AppHandle, event: CalendarEvent) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = app
            .try_state::<CalendarBridge<tauri::Wry>>()
            .ok_or_else(|| "日历组件未初始化".to_string())?;
        return bridge.run("writeEvent", event);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        write_outlook(&event)
    }
}

#[tauri::command]
pub fn calendar_remove_event(
    app: AppHandle,
    task_id: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &title;
        let bridge = app
            .try_state::<CalendarBridge<tauri::Wry>>()
            .ok_or_else(|| "日历组件未初始化".to_string())?;
        return bridge.run("removeEvent", serde_json::json!({ "taskId": task_id }));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &task_id);
        // 桌面的 Outlook 事件按标题去重，删除时也必须用标题定位。
        let title = title
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "缺少任务名称，无法定位 Outlook 日历事件".to_string())?;
        remove_outlook(&title)
    }
}

/// 桌面端：写进 Outlook 默认日历（文件夹 9 = olFolderCalendar）。
///
/// 去重键是主题文本：先删同主题的旧事件再建新的。RecurrenceType 1 =
/// olRecursDaily，Interval 即每 N 天。没装 Outlook（或被组策略禁用 COM）
/// 时 New-Object 会失败——那种环境本来也没有可写的系统日历，让前端
/// 回退 .ics 导出。
#[cfg(not(target_os = "android"))]
fn write_outlook(event: &CalendarEvent) -> Result<serde_json::Value, String> {
    let esc = |s: &str| s.replace('\'', "''");
    let title = esc(&event.title);
    let body = esc(event.description.as_deref().unwrap_or(""));
    let start = event.start_local.trim().to_string();
    if start.is_empty() {
        return Err("缺少开始时间".into());
    }

    let mut ps = String::from("$ErrorActionPreference='Stop'\n");
    ps.push_str("$outlook = New-Object -ComObject Outlook.Application\n");
    ps.push_str("$ns = $outlook.GetNamespace('MAPI')\n");
    ps.push_str("$cal = $ns.GetDefaultFolder(9)\n");
    ps.push_str(&format!("$subject = '{title}'\n"));
    ps.push_str("$old = @($cal.Items.Restrict(\"[Subject] = '\" + $subject + \"'\"))\n");
    ps.push_str("foreach ($o in $old) { $o.Delete() }\n");
    ps.push_str("$appt = $outlook.CreateItem(1)\n");
    ps.push_str(&format!(
        "$appt.Start = [datetime]::ParseExact('{start}', 'yyyy-MM-dd HH:mm', $null)\n"
    ));
    ps.push_str(&format!("$appt.Subject = '{title}'\n"));
    if !body.is_empty() {
        ps.push_str(&format!("$appt.Body = '{body}'\n"));
    }
    ps.push_str("$appt.ReminderSet = $true\n");
    ps.push_str(&format!(
        "$appt.ReminderMinutesBeforeStart = {}\n",
        event.reminder_minutes.max(0)
    ));
    ps.push_str("$appt.Categories = 'HomeLedger'\n");
    if let Some(n) = event.interval_days.filter(|n| *n > 0) {
        ps.push_str("$rp = $appt.GetRecurrencePattern()\n");
        ps.push_str("$rp.RecurrenceType = 1\n");
        ps.push_str(&format!("$rp.Interval = {n}\n"));
        ps.push_str("$rp.PatternStartDate = $appt.Start.Date\n");
    }
    ps.push_str("$appt.Save()\n");
    ps.push_str("Write-Output 'HOMELEDGER_OK'");

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    // 不加 CREATE_NO_WINDOW，每次同步都会闪一个控制台黑框。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("无法启动 PowerShell：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.contains("HOMELEDGER_OK") {
        return Ok(serde_json::json!({ "outlook": true }));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr.lines().take(3).collect::<Vec<_>>().join(" / ");
    if stderr.contains("Outlook.Application") || tail.contains("Outlook") {
        return Err("这台电脑上没有可用的 Outlook，无法直接写入系统日历".into());
    }
    Err(format!("写入 Outlook 日历失败：{tail}"))
}

/// 桌面端：按标题撤回 HomeLedger 写进 Outlook 默认日历的事件。
///
/// 只删 Categories 带 `HomeLedger` 的条目，避免误删用户自己创建的、
/// 恰好同名的日程。标题里出现单引号时按 PowerShell 的规则转义。
#[cfg(not(target_os = "android"))]
fn remove_outlook(title: &str) -> Result<serde_json::Value, String> {
    let subject = title.replace('\'', "''");
    let mut ps = String::from("$ErrorActionPreference='Stop'\n");
    ps.push_str("$outlook = New-Object -ComObject Outlook.Application\n");
    ps.push_str("$ns = $outlook.GetNamespace('MAPI')\n");
    ps.push_str("$cal = $ns.GetDefaultFolder(9)\n");
    ps.push_str(&format!("$subject = '{subject}'\n"));
    ps.push_str("$old = @($cal.Items.Restrict(\"[Subject] = '\" + $subject + \"'\"))\n");
    ps.push_str("$removed = 0\n");
    ps.push_str("foreach ($o in $old) {\n");
    ps.push_str("  if ($o.Categories -like '*HomeLedger*') { $o.Delete(); $removed++ }\n");
    ps.push_str("}\n");
    ps.push_str("Write-Output ('HOMELEDGER_REMOVED=' + $removed)");

    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("无法启动 PowerShell：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let marker = "HOMELEDGER_REMOVED=";
    if output.status.success() && stdout.contains(marker) {
        let removed = stdout
            .split(marker)
            .nth(1)
            .and_then(|rest| rest.lines().next())
            .and_then(|n| n.trim().parse::<i64>().ok())
            .unwrap_or(0);
        return Ok(serde_json::json!({ "outlook": true, "removed": removed }));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr.lines().take(3).collect::<Vec<_>>().join(" / ");
    if stderr.contains("Outlook.Application") || tail.contains("Outlook") {
        return Err("这台电脑上没有可用的 Outlook，无法从系统日历移除".into());
    }
    Err(format!("从 Outlook 日历移除失败：{tail}"))
}
