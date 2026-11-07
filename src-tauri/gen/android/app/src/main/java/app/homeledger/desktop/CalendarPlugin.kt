package app.homeledger.desktop

import android.Manifest
import android.app.Activity
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.provider.CalendarContract
import app.tauri.PermissionHelper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 维护任务 → 系统日历。
 *
 * HomeLedger 里「维护」既有一次性任务也有周期计划（interval_days），这里
 * 一律映射成日历事件：一次性任务一条普通事件；周期计划一条 RRULE
 * （FREQ=DAILY;INTERVAL=N）循环事件，由系统日历自己负责往后滚动和提醒。
 *
 * 去重键用 CUSTOM_APP_PACKAGE + CUSTOM_APP_URI（= HomeLedger 的任务 id），
 * 重复点「写入系统日历」是更新而不是再插一条；任务完成后到期日顺延，
 * 再点一次即可把事件挪到新的日期。
 *
 * 权限：清单里已声明 READ/WRITE_CALENDAR，运行时在首次写入时弹系统授权框，
 * 授权后带着原始参数（含要写的内容）重试。
 */
@InvokeArg
class CalendarEventArgs {
  var taskId: String = ""
  var title: String = ""
  var description: String? = null
  var startMs: Long = 0
  var durationMs: Long = 0
  var allDay: Boolean = false
  var intervalDays: Int? = null
  var reminderMinutes: Int = 0
}

@TauriPlugin(
  permissions = [
    Permission(
      strings = [Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR],
      alias = "calendar"
    )
  ]
)
class CalendarPlugin(private val activity: Activity) : Plugin(activity) {

  companion object {
    /**
     * 去重键优先用公开列 customAppUri。AOSP 里另有隐藏列 customAppId，
     * 但小米 HyperOS 的日历提供器不实现它——查询会直接抛
     * IllegalArgumentException: Invalid column customAppId，导致整次写入失败。
     * customAppId 只作为旧版本事件的兜底查询，且必须包在 try/catch 里。
     */
    private const val CUSTOM_APP_ID_COLUMN = "customAppId"

    private fun appUri(taskId: String): String = "homeledger://maintenance/$taskId"
  }

  private fun granted(): Boolean = PermissionHelper.hasPermissions(
    activity,
    arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
  )

  @Command
  fun hasPermission(invoke: Invoke) {
    val out = JSObject()
    out.put("granted", granted())
    invoke.resolve(out)
  }

  @Command
  fun writeEvent(invoke: Invoke) {
    if (!granted()) {
      // 别在没授权时硬塞数据：先把系统授权框弹出来，结果走回调重试。
      requestPermissionForAlias("calendar", invoke, "onCalendarPermission")
      return
    }
    write(invoke)
  }

  @PermissionCallback
  private fun onCalendarPermission(invoke: Invoke) {
    if (granted()) {
      write(invoke)
    } else {
      invoke.reject("未授予日历权限，无法写入系统日历")
    }
  }

  @Command
  fun removeEvent(invoke: Invoke) {
    val args = invoke.parseArgs(CalendarEventArgs::class.java)
    try {
      val cr = activity.contentResolver
      val deleted = deleteByTaskId(cr, args.taskId)
      val out = JSObject()
      out.put("removed", deleted)
      invoke.resolve(out)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "从日历移除失败", e)
    }
  }

  private fun write(invoke: Invoke) {
    val args = invoke.parseArgs(CalendarEventArgs::class.java)
    try {
      val cr = activity.contentResolver
      val calendarId = pickCalendarId(cr)
      if (calendarId == null) {
        invoke.reject("设备上没有可见的日历账户，请先在系统日历里登录或添加一个账户")
        return
      }

      val tz = java.util.TimeZone.getDefault().id
      val interval = args.intervalDays ?: 0
      val recurring = interval > 0
      val existingId = findEventId(cr, args.taskId)
      val durationMs = if (args.durationMs > 0) args.durationMs else 30L * 60_000L

      val values = ContentValues()
      values.put(CalendarContract.Events.CALENDAR_ID, calendarId)
      values.put(CalendarContract.Events.TITLE, args.title)
      values.put(CalendarContract.Events.DESCRIPTION, args.description)
      values.put(CalendarContract.Events.DTSTART, args.startMs)
      if (args.allDay) {
        values.put(CalendarContract.Events.ALL_DAY, 1)
        values.put(CalendarContract.Events.DTEND, args.startMs + DateUtils.DAY_IN_MILLIS)
      } else {
        values.put(CalendarContract.Events.DTEND, args.startMs + durationMs)
      }
      values.put(CalendarContract.Events.EVENT_TIMEZONE, tz)
      values.put(CalendarContract.Events.CUSTOM_APP_PACKAGE, activity.packageName)
      values.put(CalendarContract.Events.CUSTOM_APP_URI, appUri(args.taskId))
      if (recurring) {
        // 循环事件不能带 DTEND（提供器会拒绝），必须用 DURATION 表示单次时长，
        // 再由 RRULE 交给系统日历往后滚。
        values.putNull(CalendarContract.Events.DTEND)
        values.put(
          CalendarContract.Events.DURATION,
          if (args.allDay) "P1D" else "P${(durationMs / 1000L).coerceAtLeast(1L)}S"
        )
        values.put(CalendarContract.Events.RRULE, "FREQ=DAILY;INTERVAL=$interval")
      } else {
        values.putNull(CalendarContract.Events.RRULE)
        values.putNull(CalendarContract.Events.DURATION)
      }

      val eventId: Long
      if (existingId != null) {
        val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existingId)
        cr.update(uri, values, null, null)
        eventId = existingId
      } else {
        val uri = cr.insert(CalendarContract.Events.CONTENT_URI, values)
          ?: run { invoke.reject("写入系统日历失败"); return }
        eventId = ContentUris.parseId(uri)
      }

      // 提醒按「事件开始前 N 分钟」记；重复同步时先清掉旧的再加，避免翻倍。
      cr.delete(
        CalendarContract.Reminders.CONTENT_URI,
        "${CalendarContract.Reminders.EVENT_ID}=?",
        arrayOf(eventId.toString())
      )
      if (args.reminderMinutes > 0) {
        val rv = ContentValues()
        rv.put(CalendarContract.Reminders.EVENT_ID, eventId)
        rv.put(CalendarContract.Reminders.MINUTES, args.reminderMinutes)
        rv.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
        cr.insert(CalendarContract.Reminders.CONTENT_URI, rv)
      }

      val out = JSObject()
      out.put("eventId", eventId)
      out.put("updated", existingId != null)
      invoke.resolve(out)
    } catch (e: SecurityException) {
      invoke.reject("未授予日历读写权限", e)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "写入系统日历失败", e)
    }
  }

  /** 第一个可见日历；优先主日历（一般是用户日常用的那个账户）。 */
  private fun pickCalendarId(cr: ContentResolver): Long? {
    val projection = arrayOf(
      CalendarContract.Calendars._ID,
      CalendarContract.Calendars.IS_PRIMARY
    )
    val selection = "${CalendarContract.Calendars.VISIBLE}=1"
    val order = "${CalendarContract.Calendars.IS_PRIMARY} DESC"
    cr.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, null, order)?.use { c ->
      if (c.moveToFirst()) return c.getLong(0)
    }
    return null
  }

  private fun findEventId(cr: ContentResolver, taskId: String): Long? {
    findEventIdBy(cr, CalendarContract.Events.CUSTOM_APP_URI, appUri(taskId))?.let { return it }
    // 兼容 2.0.0 在支持的 ROM 上写下的旧事件；HyperOS 不支持这一列，
    // 查询会抛 IllegalArgumentException，忽略即可。
    return try {
      findEventIdBy(cr, CUSTOM_APP_ID_COLUMN, taskId)
    } catch (_: Exception) {
      null
    }
  }

  private fun findEventIdBy(
    cr: ContentResolver,
    column: String,
    value: String
  ): Long? {
    val selection = "${CalendarContract.Events.CUSTOM_APP_PACKAGE}=? AND $column=?"
    cr.query(
      CalendarContract.Events.CONTENT_URI,
      arrayOf(CalendarContract.Events._ID),
      selection,
      arrayOf(activity.packageName, value),
      null
    )?.use { c ->
      if (c.moveToFirst()) return c.getLong(0)
    }
    return null
  }

  private fun deleteByTaskId(cr: ContentResolver, taskId: String): Int {
    var deleted = deleteByColumn(cr, CalendarContract.Events.CUSTOM_APP_URI, appUri(taskId))
    deleted += try {
      deleteByColumn(cr, CUSTOM_APP_ID_COLUMN, taskId)
    } catch (_: Exception) {
      0
    }
    return deleted
  }

  private fun deleteByColumn(cr: ContentResolver, column: String, value: String): Int {
    val selection = "${CalendarContract.Events.CUSTOM_APP_PACKAGE}=? AND $column=?"
    return cr.delete(
      CalendarContract.Events.CONTENT_URI,
      selection,
      arrayOf(activity.packageName, value)
    )
  }
}

private object DateUtils {
  const val DAY_IN_MILLIS: Long = 24L * 60 * 60 * 1000
}
