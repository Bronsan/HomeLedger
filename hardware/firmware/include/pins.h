// 引脚分配 —— 与 docs/HARDWARE.md §4.1 一一对应。
//
// 这块板子只有一个容易被忽略的约束：DVP 的 8 根数据线要排在同一侧，
// 中间不能夹 SPI 的 SCLK。OV2640 在 10MHz XCLK 下对串扰很敏感，
// 排错一次的症状是「偶尔能扫出来」——这种问题最难查，所以在原理图阶段就避开。

#pragma once

// --- 摄像头（DVP 8-bit）----------------------------------------------------
#define PIN_CAM_XCLK 15
#define PIN_CAM_PCLK 13
#define PIN_CAM_VSYNC 6
#define PIN_CAM_HREF 7
#define PIN_CAM_SDA 4
#define PIN_CAM_SCL 5

#define PIN_CAM_D0 11
#define PIN_CAM_D1 9
#define PIN_CAM_D2 8
#define PIN_CAM_D3 10
#define PIN_CAM_D4 12
#define PIN_CAM_D5 18
#define PIN_CAM_D6 17
#define PIN_CAM_D7 16

// --- 屏幕（ST7789，SPI2）---------------------------------------------------
#define PIN_LCD_SCLK 21
#define PIN_LCD_MOSI 47
#define PIN_LCD_CS 14
#define PIN_LCD_DC 45
#define PIN_LCD_RST 46
#define PIN_LCD_BL 48

// --- 人机 ------------------------------------------------------------------
#define PIN_BTN_SCAN 0  // 兼作 BOOT；低有效，内部上拉
#define PIN_BTN_PAIR 3  // 长按 3 秒进配网
#define PIN_BUZZER 38
#define PIN_LED 39  // WS2812B-2020

// --- 电源 ------------------------------------------------------------------
#define PIN_VBAT 1  // ADC1_CH0，100k/100k 分压
#define PIN_CHG_STAT 2
