package app.homeledger.desktop

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 手机端的窗口形态。
 *
 * 这是一个「拿在手里、对着货架」的应用，所以它要占满整块屏幕：状态栏收起来，
 * 内容一直画到屏幕边缘，刘海区域也用上。
 *
 * 收不起来的情况是存在的——分屏、某些定制系统、以及用户自己在系统设置里锁了
 * 状态栏。那时什么都不做：布局会退回 `env(safe-area-inset-top)` 的补白，
 * 内容自动从上边条下面让开，而不是被压在时钟底下。
 *
 * 注意 onWindowFocusChanged 里的重复调用：从相机、文件选择器、系统权限对话框
 * 返回时，状态栏会被系统重新显示，只有重新进入前台才会再隐藏一次。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    immersive()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) immersive()
  }

  private fun immersive() {
    WindowCompat.setDecorFitsSystemWindows(window, false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      // 短边模式：横屏时允许内容进入刘海两侧，而不是被裁成一条窄带。
      window.attributes =
        window.attributes.apply {
          layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    val controller = WindowCompat.getInsetsController(window, window.decorView)
    // 向下滑一下就能临时叫出状态栏——用户要回微信时不该被困住。
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.statusBars())
  }
}
