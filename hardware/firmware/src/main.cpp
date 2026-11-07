// 入库扫描器 —— 固件骨架
//
// 这不是一个能直接烧进去就用的成品固件，而是把 docs/HARDWARE.md §6 的任务划分
// 落成一条可读的主线：取帧 → 解码 → 去重 → 上报 → 反馈 → 空闲休眠。
// 每一段都写了「为什么是它」，方便改的时候不至于改错地方。
//
// 它**没有**在这台机器上编译过（没有 ESP-IDF 工具链），第一次跑起来必然会遇到
// 板子相关的琐碎问题。缺的部分在文件末尾列了出来。

#include <Arduino.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_sleep.h>

#include "pins.h"

extern "C" {
#include "quirc.h"
}

namespace {

// ---------------------------------------------------------------------------
// 配置：一次配网，之后存在 NVS 里
// ---------------------------------------------------------------------------
struct Config {
  String ssid;
  String pass;
  String server;  // 形如 http://192.168.1.10:8000/api/v1
  String token;
  String family;
  String device;
};

Config cfg;

bool loadConfig() {
  Preferences p;
  p.begin("hl", true);
  cfg.ssid = p.getString("ssid", "");
  cfg.pass = p.getString("pass", "");
  cfg.server = p.getString("server", "");
  cfg.token = p.getString("token", "");
  cfg.family = p.getString("family", "");
  cfg.device = p.getString("device", "");
  p.end();
  return cfg.ssid.length() && cfg.server.length() && cfg.token.length();
}

// ---------------------------------------------------------------------------
// 摄像头
//
// VGA + JPEG 是刻意的：JPEG 由传感器硬件编码，CPU 只负责把 20KB 左右的
// 数据交给解码器。若改成 RGB565，一帧 600KB，PSRAM 带宽会成为瓶颈，
// 帧率反而更低。灰度化交给 quirc 前的预处理，不做整帧转换。
// ---------------------------------------------------------------------------
bool cameraBegin() {
  camera_config_t c = {};
  c.pin_pwdn = -1;
  c.pin_reset = -1;
  c.pin_xclk = PIN_CAM_XCLK;
  c.pin_sscb_sda = PIN_CAM_SDA;
  c.pin_sscb_scl = PIN_CAM_SCL;
  c.pin_d0 = PIN_CAM_D0;
  c.pin_d1 = PIN_CAM_D1;
  c.pin_d2 = PIN_CAM_D2;
  c.pin_d3 = PIN_CAM_D3;
  c.pin_d4 = PIN_CAM_D4;
  c.pin_d5 = PIN_CAM_D5;
  c.pin_d6 = PIN_CAM_D6;
  c.pin_d7 = PIN_CAM_D7;
  c.pin_vsync = PIN_CAM_VSYNC;
  c.pin_href = PIN_CAM_HREF;
  c.pin_pclk = PIN_CAM_PCLK;

  c.xclk_freq_hz = 10000000;  // 10MHz：OV2640 在这个频率下串扰最小
  c.ledc_timer = LEDC_TIMER_0;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_VGA;
  c.jpeg_quality = 12;  // 数字越小越清晰；12 在 240×240 屏上够看
  c.fb_count = 2;       // 双缓冲：解码时不挡下一帧
  c.grab_mode = CAMERA_GRAB_LATEST;
  c.fb_location = CAMERA_FB_IN_PSRAM;

  return esp_camera_init(&c) == ESP_OK;
}

// ---------------------------------------------------------------------------
// 解码
//
// quirc 只认 QR。商品条码（EAN-13）的 MCU 移植版见文档 §6.2 —— 那是另一条
// 流水线，模型更简单（一维），但需要在灰度图上找行扫描线，这里没写。
// ---------------------------------------------------------------------------
struct quirc *qr = nullptr;

String decodeQr(camera_fb_t *fb) {
  if (!qr) {
    qr = quirc_new();
    if (!qr || quirc_resize(qr, fb->width, fb->height) < 0) return "";
  }

  // JPEG → 灰度。esp32-camera 提供 fmt2rgb888，但它输出 RGB；quirc 要灰度，
  // 所以在拷贝时顺手算亮度，省一次遍历。
  const size_t w = fb->width, h = fb->height;
  uint8_t *buf = quirc_begin(qr, nullptr, nullptr);
  if (!buf) return "";

  if (fb->format == PIXFORMAT_JPEG) {
    // 骨架里用最简单的方式：解成 RGB888 再转灰度。
    // 量产固件应改成 jpeg2gray 内联版本，省掉 600KB 的中间缓冲。
    uint8_t *rgb = (uint8_t *)malloc(w * h * 3);
    if (!rgb) return "";
    if (!fmt2rgb888(fb->buf, fb->len, fb->format, rgb)) {
      free(rgb);
      quirc_end(qr);
      return "";
    }
    for (size_t i = 0; i < w * h; i++) {
      // ITU-R BT.601 的定点近似：0.299/0.587/0.114
      buf[i] = (uint8_t)((rgb[i * 3] * 77 + rgb[i * 3 + 1] * 150 + rgb[i * 3 + 2] * 29) >> 8);
    }
    free(rgb);
  } else {
    memcpy(buf, fb->buf, w * h);
  }

  quirc_end(qr);

  const int n = quirc_count(qr);
  String out;
  for (int i = 0; i < n; i++) {
    quirc_decode_error_t err;
    struct quirc_code code;
    struct quirc_data data;
    quirc_extract(qr, i, &code);
    err = quirc_decode(&code, &data);
    if (err == QUIRC_SUCCESS) {
      out = String((const char *)data.payload);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------
enum class Result { Known, Unknown, Offline, BadToken };

Result report(const String &code, String &label) {
  if (WiFi.status() != WL_CONNECTED) return Result::Offline;

  HTTPClient http;
  http.setTimeout(4000);  // 超过 4 秒就不等了——宁可让用户重扫一次
  http.begin(cfg.server + "/scan/lookup?code=" + code);
  http.addHeader("Authorization", "Bearer " + cfg.token);
  http.addHeader("X-Family-Id", cfg.family);

  const int status = http.GET();
  if (status == 401) {
    http.end();
    return Result::BadToken;  // 令牌过期：调用方负责重新登录
  }
  if (status != 200) {
    http.end();
    return Result::Offline;
  }

  String body = http.getString();
  http.end();

  // 只取 name 字段就够屏幕显示了。用现成 JSON 库会把 flash 吃满，
  // 这里做最小的字符串搜索；字段顺序由服务端保证（pydantic 固定）。
  const int k = body.indexOf("\"name\":\"");
  if (k < 0) return Result::Unknown;
  int a = k + 8;
  int b = body.indexOf('"', a);
  label = body.substring(a, b);
  return label.length() ? Result::Known : Result::Unknown;
}

// ---------------------------------------------------------------------------
// 反馈：声音 + 颜色 + （可选）屏幕
//
// 入库常在储物间，光线暗、手上还拿着东西。声音是第一通道，屏幕是辅助。
// ---------------------------------------------------------------------------
void feedback(Result r) {
  switch (r) {
    case Result::Known:
      tone(PIN_BUZZER, 2400, 60);
      neopixelWrite(PIN_LED, 0, 24, 0);
      break;
    case Result::Unknown:
      tone(PIN_BUZZER, 1800, 90);
      delay(90);
      tone(PIN_BUZZER, 1400, 120);
      neopixelWrite(PIN_LED, 24, 14, 0);
      break;
    case Result::Offline:
      tone(PIN_BUZZER, 900, 150);
      neopixelWrite(PIN_LED, 24, 0, 0);
      break;
    case Result::BadToken:
      tone(PIN_BUZZER, 700, 200);
      neopixelWrite(PIN_LED, 12, 0, 24);
      break;
  }
}

// ---------------------------------------------------------------------------
// 去重
//
// 连续扫码时同一帧会被解出十几次。1.5 秒内的同一个码只报一次，
// 不同的码立刻报——「一箱同款牛奶」是真实场景，不能按时间合并。
// ---------------------------------------------------------------------------
String lastCode;
uint32_t lastAt = 0;

bool shouldReport(const String &code) {
  const uint32_t now = millis();
  if (code == lastCode && now - lastAt < 1500) return false;
  lastCode = code;
  lastAt = now;
  return true;
}

// ---------------------------------------------------------------------------
// 休眠：90 秒无操作断 WiFi 熄屏，300 秒进深度睡眠
// ---------------------------------------------------------------------------
const uint32_t IDLE_WIFI_MS = 90 * 1000;
const uint32_t IDLE_SLEEP_MS = 300 * 1000;

void sleepNow() {
  WiFi.disconnect(true);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)PIN_BTN_SCAN, 0);  // 低电平唤醒
  esp_deep_sleep_start();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN_SCAN, INPUT_PULLUP);
  pinMode(PIN_BTN_PAIR, INPUT_PULLUP);

  if (!loadConfig()) {
    // TODO: BLE 配网（文档 §7）。骨架里先要求用串口写一次配置：
    //   hl-setup <ssid> <pass> <server> <token> <family>
    Serial.println("未配网：请通过 BLE 或串口写入配置");
    neopixelWrite(PIN_LED, 0, 0, 24);
    return;
  }

  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  if (!cameraBegin()) {
    Serial.println("摄像头初始化失败：先确认 PSRAM 已开启");
    neopixelWrite(PIN_LED, 24, 0, 0);
  }
}

void loop() {
  static uint32_t lastActivity = millis();

  if (digitalRead(PIN_BTN_PAIR) == LOW) {
    delay(3000);
    if (digitalRead(PIN_BTN_PAIR) == LOW) {
      // TODO: 进入配网窗口（BLE 广播 120 秒），见文档 §7.1
      Serial.println("配网模式（未实现）");
    }
  }

  if (digitalRead(PIN_BTN_SCAN) != LOW) {
    if (millis() - lastActivity > IDLE_SLEEP_MS) sleepNow();
    delay(20);
    return;
  }

  lastActivity = millis();

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    delay(100);
    return;
  }
  const String code = decodeQr(fb);
  esp_camera_fb_return(fb);

  if (!code.length()) {
    delay(120);  // 没解出来：下一帧，不发声（连续滴滴会让人以为坏了）
    return;
  }
  if (!shouldReport(code)) return;

  String label;
  const Result r = report(code, label);
  feedback(r);

  Serial.printf("%s → %d %s\n", code.c_str(), (int)r, label.c_str());

  if (millis() - lastActivity > IDLE_WIFI_MS) {
    WiFi.disconnect(true);
  }
}

// ---------------------------------------------------------------------------
// 还没写的部分（按重要性）
//
// 1. BLE 配网：NimBLE + 文档 §7.2 的 GATT 表。这是唯一「不做就没法用」的缺口。
// 2. 离线队列：NVS 环形缓冲 512 条，重放时先 lookup 再 create（天然幂等）。
// 3. 屏幕：ST7789 + LVGL 或直接写 sprite，只显示三行：品名 / 位置 / 状态。
// 4. 条码：EAN-13 / Code128 的一维解码，走另一条流水线。
// 5. OTA：双分区 + 版本回滚。
// 6. 低电保护：3.5V 提示、3.4V 拒绝开机。
// ---------------------------------------------------------------------------
