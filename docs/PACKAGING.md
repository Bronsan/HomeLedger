# 多平台出包

一份代码，四个平台，但**不能在一台机器上打出全部安装包**。这不是配置问题，是各平台的
工具链决定的。下表是现状，空格子里写的是"为什么这里出不来"。

| 产物 | 平台 | 本仓库能否在 Linux 上直接产出 | 说明 |
|------|------|------------------------------|------|
| `HomeLedger_1.0.2_amd64.deb` | Debian/Ubuntu | ✅ 可以 | 含内置 Python 服务，双击安装即用 |
| `HomeLedger_1.0.2_x64.exe` | Windows | ⚠️ 只出了壳 | 交叉编译成功，但不含内置服务，见下 |
| `HomeLedger_1.0.2_aarch64.apk` | Android | ✅ 可以 | 手机自带本地库，不需要 sidecar |
| `HomeLedger_1.0.2_aarch64.dmg` | macOS | ❌ 不行 | 需要 macOS 的 SDK 和 `hdiutil` |

## 为什么

### .exe：壳能交叉编译，Python 服务不能

`cargo-xwin` 能在 Linux 上把 Rust 部分编译成合法的 PE32+ 可执行文件（已验证，见
`scripts/`），但随包分发的后端是 PyInstaller 产物。PyInstaller **不是交叉编译器**：
它把当前这台机器的解释器和当前平台的二进制轮子（`pydantic_core`、`cryptography`、
`pillow` 都是编译好的 .so）打进产物里。在 Linux 上跑出来的东西在 Windows 上是一堆
无法执行的 ELF 文件。

所以本目录里的 `HomeLedger_1.0.2_x64.exe` 是**没有内置服务的壳**：

- 想连家里的网关：启动后点"连接到已有的家庭网关"，填 `http://192.168.x.x:8000`，正常用。
- 想在 Windows 上本地跑：在那台 Windows 机器上跑一次
  `.\scripts\build-desktop.ps1`，几行命令就能得到带服务的完整安装器。

另外，交叉编译出来的 exe 无法在 Linux 上运行验证（没有 WebView2，也没有 Wine 能跑
WebView2），Tauri 官方对这条路径的定性就是 *experimental*。要交付给真实用户，
**用 CI 在 `windows-latest` 上出的包**，那是原生编译，不存在这类风险。

### .dmg：只能由 macOS 生成

`hdiutil`、`codesign`、`security` 和 Apple 的 SDK 都只随 Xcode 分发，Linux 上没有
任何替代实现。社区里的 `dmg` 打包工具（如 `create-dmg`）本身也只是调用 `hdiutil` 的
壳。想在 Linux 上出 dmg，唯一的办法是跑一台 macOS（真机或 CI 的 macOS runner）。

### .apk：能出，且手机是完整的本地客户端

手机上没有 Python、没有能长期驻留的进程，所以 APK **不打包 sidecar**。但和上一版不同，
它也不再是「必须连网关」的薄壳：

- 首次启动就在本机建库，扫码、拍照、录入、查询全部离线可用；
- 数据存在应用沙箱内的 IndexedDB 里；
- 需要多设备共享时，在「设置 → 同步」里填网关地址 + 一句同步口令，隐私字段与照片
  在离开手机前已经加密。

「网关」不必是专门的机器：桌面端在同一个设置页里点一次「允许家庭内设备连接」，
它就变成局域网服务器，地址直接显示在界面上，填到手机里即可。见 ADR-026。

托盘、数据目录、内置服务重试这些桌面专属能力在手机上编译期就不存在。

同步容器的打包细节：Android 包里**不能**出现 `src-tauri/server/`（那是 Linux ELF），
`tauri.android.conf.json` 把 `resources` 置空，构建脚本在打包前再清一次目录。

> **一个踩过的坑**：Tauri 会把 `bundle.resources` 复制进 Android 工程的
> `assets/`，但**不会清理上一次留下的文件**。先打桌面包（`src-tauri/server/` 里
> 多了个近百 MB 的 Linux sidecar）再打安卓包，那个 ELF 会原样混进 APK，体积从
> 7MB 涨到 100MB 以上。`tauri.android.conf.json` 把 `resources` 置空，构建脚本在
> 打包前再清一次目录，两道保险。

## 构建命令

### Linux（deb / rpm）

```bash
./scripts/build-desktop.sh                     # deb + rpm
./scripts/build-desktop.sh --bundles deb,rpm,appimage
```

三步：前端 → PyInstaller sidecar → Tauri 打包。产物在 `src-tauri/target/release/bundle/`。

默认只出 `deb` 和 `rpm`。`appimage` 要单独指定，因为它需要从 GitHub 下载 AppRun
脚手架——网络不通时会卡几分钟才超时，而且失败发生在 deb/rpm 已经写好之后，
看起来像整体失败。`--skip-frontend` / `--skip-sidecar` 用于只改了一层时快速出包。

### Windows：一条命令出 EXE 安装包 + 免安装版

```
.\scripts\build-windows.ps1
.\scripts\build-windows.ps1 -SkipFrontend    # 只改了后端
.\scripts\build-windows.ps1 -SkipSidecar     # 只改了前端
```

产物进 `dist\`：`HomeLedger_<ver>_x64-setup.exe` 和
`HomeLedger-<ver>-win-x64-portable.zip`（解压即用，不写注册表）。

和 `build-desktop.ps1` 的区别：这个脚本不要求 pnpm（用 npm / npx），固定出 NSIS
的 setup.exe，并且顺手打免安装包。安装器在 `tauri.conf.json` 的
`bundle.windows.nsis` 里配置：简体中文、当前用户安装、无管理员弹窗、不显示语言
选择页，安装流程只有「欢迎 → 选择目录 → 安装 → 完成」。覆盖安装/升级不会重置
数据；卸载时勾选「删除应用程序数据」会清理 `%APPDATA%\HomeLedger`，这段逻辑由
`src-tauri/nsis/installer-hooks.nsh` 补上。三个坑已经写进脚本注释：

* `$ErrorActionPreference` 必须是 `Continue`。5.1 会把原生命令写到 stderr 的
  任何一行当成终止性错误，而 vite 会往 stderr 打无害警告，用 `Stop` 会在正常
  输出之后突然中断。
* 读 `package.json` 要带 `-Encoding UTF8`，否则中文描述被按 ANSI 解码，
  `ConvertFrom-Json` 直接失败。
* 打 zip 用 `%SystemRoot%\System32\tar.exe` 而不是 `Compress-Archive`：
  后者写的条目用反斜杠做分隔符，Linux/macOS 的 unzip 会报警告。

#### 固定签名（Windows）

`build-windows.ps1` 固定调用 `scripts/sign-windows.ps1`，证书材料在
`%USERPROFILE%\.homeledger-signing\windows\`，由 `setup-windows-signing.ps1`
一次性创建后一直复用，不要重新生成。证书 `CN=HomeLedger`，指纹
`DF900FABA21C897EA1EF42912711856081B8921A`，有效期 10 年，使用 SHA-256
和 DigiCert 时间戳。

这是自签名证书，根证书不在 Windows 信任列表里，所以
`Get-AuthenticodeSignature` 会显示 `UnknownError`，`signtool verify /pa`
会报「根证书不受信任」——签名本身已经写入，属于预期结果。要彻底消除
SmartScreen 的「未知发布者」，需要购买受信任的代码签名证书；换证书会改变
发布者，确定后不再更换。想在本机临时信任，可导入
`homeledger-codesign.cer`。

签名顺序有讲究：`tauri build --no-bundle` 之后先清掉主程序旧签名，再让
`tauri bundle` 写安装类型标记；否则签名会变成 `HashMismatch`。安装包内层的
`homeledger-desktop.exe` 保持未签名（外层 setup.exe 已签），portable 压缩包
里的 exe 在打包前单独签名。

### Windows（NSIS 安装器）

在 Windows 上：

```powershell
.\scripts\build-desktop.ps1
```

产物 `dist\HomeLedger_<version>_x64-setup.exe`。

在 Linux 上交叉编译（只能得到无 sidecar 的裸 exe）：

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin --locked
sudo apt install nsis clang lld llvm

./node_modules/.bin/tauri build \
  --target x86_64-pc-windows-msvc \
  --runner cargo-xwin \
  --bundles nsis
```

> NSIS 安装器这一步在纯 Linux 环境里常常走不通：Tauri 的 bundler 会去 GitHub 下载
> `nsis_tauri_utils.dll` 和 Windows 版 `NSIS.exe`，没有外网或外网被墙时直接超时。
> 裸 exe 不受影响，它在 bundler 之前就已经编译完了。

**在 Windows 本机构建时，卡住的往往也是同一个地方。** Tauri 的 NSIS bundler 会去
GitHub Releases 下载 `nsis-3.13.zip`，国内网络经常在 TLS 握手上被掐断：

```
io: peer closed connection without sending TLS close_notify
```

此时 Rust 侧已经编译完成，卡住的只是一个打包器。本机只要缓存过 NSIS
（`%LOCALAPPDATA%\tauri\NSIS`），`build-windows.ps1` 就能离线出 setup.exe；缓存
缺失时，先让 Tauri 在有网的机器上下载一次，或把整个 `NSIS` 目录复制到同一位置。
`build-desktop.ps1` 仍保留「NSIS 失败退回 MSI」的兜底，但正式分发用
`build-windows.ps1` 的 EXE。

### 便携版：一个 exe + 一页说明

`dist/` 里那个 `HomeLedger-<ver>-win-x64-portable.zip` 就是这么来的，不经过 NSIS：

```bash
./node_modules/.bin/tauri build --target x86_64-pc-windows-msvc \
  --runner cargo-xwin --no-bundle

cp src-tauri/target/x86_64-pc-windows-msvc/release/homeledger-desktop.exe \
   dist/HomeLedger_1.0.2_x64.exe

mkdir -p /tmp/pk && cp dist/HomeLedger_1.0.2_x64.exe /tmp/pk/HomeLedger.exe
# 使用说明.txt 里写明三件事：数据在 %APPDATA%\HomeLedger、怎么切三种模式、
# 这个包不带内置服务所以它自己当不了服务器
cd /tmp/pk && zip -9 /workspace/homeledger/dist/HomeLedger_1.0.2_x64_portable.zip \
  HomeLedger.exe 使用说明.txt
```

为什么值得单独出一个便携版：Windows 上双击 exe 就能用，不写注册表、不需要管理员权限、
不弹 UAC。对一个「先在自己电脑上试试」的人来说，这比安装器少三个决策点。

代价是它**不带 sidecar**（PyInstaller 不能交叉编译），所以它自己不能当服务器——只能连别人的。
说明文件里写清楚了这一点，免得用户装完发现「让手机连这台电脑」的按钮点了没反应。

### macOS（dmg）

在 macOS 上：

```bash
./scripts/build-desktop.sh
```

要分发给别人还得签名 + 公证，否则 Gatekeeper 会拦：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="TEAMID"
./scripts/build-desktop.sh
```

### Android（apk）

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
export JAVA_HOME=/path/to/jdk-17-or-newer

./scripts/build-android.sh              # arm64-v8a
./scripts/build-android.sh --all-abi    # 四种 ABI 分开出
```

APK 从 2.0.0 起使用固定 release key，签名材料在
`~/.homeledger-signing/android/`：`homeledger-dev.p12` 和 `password.txt`，
别名 `homeledger`，证书 SHA-256
`6994f6429c41baaa90f2693663dfe9cdcbed6477d00b618e232becb2c77fa8ad`。这个目录
不在仓库和 `dist/` 里，清理构建产物不会丢密钥。

`build-android.sh` 在没有显式指定密钥时会自动使用它，用
`ANDROID_KEYSTORE_PASSWORD_FILE` 把密码文件交给 apksigner，不把密码写进
命令行或环境变量。只有这台机器上找不到固定密钥时，才退化为输出
`*-unsigned.apk`。需要临时换密钥再设置 `ANDROID_KEYSTORE` /
`ANDROID_KEYSTORE_PASSWORD_FILE` 覆盖。

旧版 1.0.9 的 debug 签名包不能直接升级到固定签名：在
`dist/legacy/` 里另有一个 debugkey 过渡 APK，只用于「覆盖安装并保留数据」；
装过它之后仍然需要导出备份、卸载、再装固定签名版才能回到长期升级链。

### 安卓原生配置是构建脚本改的，不是手改的

`src-tauri/gen/android/` 是 `tauri android init` 生成的目录，`init` 跑一次就把里面的手改内容覆盖掉——包括 `CAMERA` 权限和沉浸式全屏的 `MainActivity.kt`。所以这两处改动写进了 `scripts/build-android.sh`：

```bash
# 在清理 sidecar 资源之后、gradle 之前
python3 - <<'PY'
# 幂等地补 AndroidManifest.xml 的 CAMERA / ACCESS_NETWORK_STATE /
# uses-feature camera(required=false) / windowSoftInputMode=adjustResize
# 幂等地重写 MainActivity.kt 的沉浸式逻辑
PY
```

「幂等」是关键词：脚本会先检查再写，重复跑不会叠加两遍 `<uses-permission>`。`gen/android/` 已经提交进仓库，所以正常情况下不需要 `init`，但**如果重新生成过工程，直接跑构建脚本即可**，不需要记住改了哪几行。

`uses-feature android.hardware.camera required="false"` 是必须的：声明成必需会让没有摄像头的设备（部分平板、电视盒子）在应用商店里看不到这个应用，而扫码只是录入的一种方式，手输和贴纸都在。

## 一次出全平台：CI

`.github/workflows/release.yml` 里是四个 runner 的矩阵：

| job | runner | 产物 |
|-----|--------|------|
| linux-x64 | ubuntu-22.04 | `.deb` + `.AppImage` |
| windows-x64 | windows-latest | NSIS `.exe` |
| macos-arm64 | macos-latest | `.dmg`（Apple Silicon） |
| macos-x64 | macos-13 | `.dmg`（Intel） |

打 tag 即发版：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

四个平台各自原生编译、各自跑自己平台的 PyInstaller，产出的才是真正能分发的包。
发布前在各平台实机各跑一次——CI 只能证明"编译通过"，证明不了"装完能用"。

## 版本号只有一个来源

`src-tauri/tauri.conf.json` 的 `version`。Windows 的 NSIS、Linux 的 deb、macOS 的
`Info.plist`、Android 的 `versionName` 都从它取。改版本只改这一处，别去动
`gen/android/app/build.gradle.kts` 里的 `versionCode`（那是构建时生成的）。

改完版本记得同步 `frontend/package.json` 和根 `package.json`，否则启动页脚显示的
版本和安装包对不上。
