#!/usr/bin/env node
// 转发到真正的 Tauri CLI。
//
// 为什么需要这个文件：`tauri android init` 生成的 Gradle 工程里，rust 插件
// 用 `node tauri android android-studio-script` 来重建 .so，工作目录是 src-tauri/。
// Node 只会把 "tauri" 当成相对路径去找（不会去 node_modules/.bin 里找），
// 于是找不到就报 `Cannot find module '.../src-tauri/tauri'`。
// 留一个同名转发文件，任何平台、任何包管理器下都能跑通。
require("../node_modules/@tauri-apps/cli/tauri.js");
