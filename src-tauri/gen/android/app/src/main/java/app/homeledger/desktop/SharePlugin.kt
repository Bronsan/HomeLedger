package app.homeledger.desktop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.Base64

/**
 * 图片出壳：分享（ACTION_SEND）与打印（PrintManager）。
 *
 * 二维码/标签图在前端是 SVG（矢量，打印不糊），但安卓的分享目标和打印
 * 框架只认位图文件。前端把 SVG 栅格化成 PNG data URL 传进来，这里负责
 * 落到 cache/shared/、走 FileProvider 交出去：
 *
 * - shareImage —— 系统分享面板。用户从面板里选「保存到相册 / 发给微信 /
 *   保存到文件」，这就是「跳转」——应用不越权替用户决定存哪儿。
 * - printImage / printHtml —— 离屏 WebView 装载内容，交给系统打印框架。
 *   Android WebView 不接 window.print()（标签页的 iframe 打印路径因此是
 *   no-op），这是唯一能弹出系统打印对话框（含「另存为 PDF」）的路径。
 */
@InvokeArg
class ShareImageArgs {
  var fileName: String = ""
  var dataUrl: String = ""
}

@InvokeArg
class PrintImageArgs {
  var jobName: String = ""
  var dataUrl: String = ""
}

@InvokeArg
class PrintHtmlArgs {
  var jobName: String = ""
  var html: String = ""
}

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {

  /** PNG data URL → cache/shared/<name>，返回文件。 */
  private fun writePng(fileName: String, dataUrl: String): File? {
    val marker = "base64,"
    val idx = dataUrl.indexOf(marker)
    if (idx < 0) return null
    val bytes = try {
      Base64.getDecoder().decode(dataUrl.substring(idx + marker.length))
    } catch (e: IllegalArgumentException) {
      return null
    }
    val dir = File(activity.cacheDir, "shared").apply { mkdirs() }
    val safe = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifEmpty { "homeledger.png" }
    val file = File(dir, safe)
    FileOutputStream(file).use { it.write(bytes) }
    return file
  }

  @Command
  fun shareImage(invoke: Invoke) {
    val args = invoke.parseArgs(ShareImageArgs::class.java)
    try {
      val file = writePng(args.fileName, args.dataUrl)
        ?: run { invoke.reject("图片解码失败"); return }
      val uri = FileProvider.getUriForFile(
        activity,
        activity.packageName + ".fileprovider",
        file
      )
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(intent, "分享 HomeLedger 图片"))
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "分享失败", e)
    }
  }

  @Command
  fun printImage(invoke: Invoke) {
    val args = invoke.parseArgs(PrintImageArgs::class.java)
    // 标签 SVG 按 60×36mm 画（709×425 @300dpi）；img 定宽让打印框架按毫米
    // 排版，而不是把屏幕像素搬上纸。
    val imgTag = "<img src=\"" + args.dataUrl + "\" style=\"width:60mm;display:block\">"
    printHtmlDocument(args.jobName.ifEmpty { "HomeLedger 标签" }, imgTag)
    invoke.resolve(JSObject().put("ok", true))
  }

  @Command
  fun printHtml(invoke: Invoke) {
    val args = invoke.parseArgs(PrintHtmlArgs::class.java)
    printHtmlDocument(args.jobName.ifEmpty { "HomeLedger 标签页" }, args.html)
    invoke.resolve(JSObject().put("ok", true))
  }

  /** 离屏 WebView 装好文档再交给系统打印框架；必须跑在主线程。 */
  private fun printHtmlDocument(jobName: String, bodyHtml: String) {
    val html = "<html><head><meta charset=\"utf-8\"><style>" +
      "@page { size: auto; margin: 4mm; }" +
      "body { margin: 0; }" +
      "</style></head><body>" + bodyHtml + "</body></html>"
    activity.runOnUiThread {
      val webView = WebView(activity)
      webView.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) {
          val printManager =
            activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
          val adapter = view.createPrintDocumentAdapter(jobName)
          printManager.print(jobName, adapter, PrintAttributes.Builder().build())
          // 打印对话框是阻塞的；任务交给系统后 WebView 留着也没用了，
          // 延迟销毁避免正好赶上渲染未完成。
          view.postDelayed({ view.destroy() }, 30_000)
        }
      }
      webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }
  }
}
