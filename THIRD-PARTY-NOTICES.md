# 第三方组件与许可证

HomeLedger 自身按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权。下表列出**直接依赖**及其许可证，供分发和合规参考。

> **这不是完整法律意见。** 传递依赖、AndroidX、Gradle 插件、Rust crate、字体、图标和打包工具链尚未逐项核对。发布二进制前，请用 `pnpm licenses list`、`pip-licenses`、`cargo about`、`gradle dependencies` 或 SBOM 工具生成完整清单，并把对应许可证文本随安装包分发。

版本以锁文件 `frontend/pnpm-lock.yaml`、`backend/requirements.txt`、`src-tauri/Cargo.lock` 和 Android Gradle 配置为准；下表是 2026-11-08 的直接依赖快照。

## 前端

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| react / react-dom | 18.3.x | MIT | UI |
| react-router-dom | 6.x | MIT | 路由 |
| @noble/ciphers | 2.x | MIT | AES-256-GCM 等 AEAD |
| @noble/hashes | 2.x | MIT | Argon2id、SHA-256 |
| qrcode | 1.5.x | MIT | 二维码生成 |
| jsqr | 1.4.x | Apache-2.0 | 相机扫码解码 |
| vite | 5.x | MIT | 构建（不随运行时分发） |
| @vitejs/plugin-react | 4.x | MIT | 构建 |
| typescript | 5.x | Apache-2.0 | 类型检查与构建 |
| esbuild | 0.21.x | MIT | 单元测试打包（不随包分发） |
| playwright-core | 1.x | Apache-2.0 | 端到端测试（不随包分发） |
| @types/* | — | MIT | 类型声明（不随包分发） |

前端生产包会把 React、React Router、noble、qrcode 和 jsqr 打入静态资源。分发安装包时请保留这些项目的版权与许可证文本。

## 字体

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| IBM Plex Sans / IBM Plex Mono | SIL Open Font License 1.1 | 界面与站点字体 |

IBM Plex 的版权归 IBM Corp. 所有，许可证全文见 <https://github.com/IBM/plex/blob/master/LICENSE.txt>。

## 后端

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| fastapi | 0.1xx | MIT | HTTP 框架 |
| starlette | — | BSD-3-Clause | ASGI 工具（FastAPI 依赖） |
| uvicorn | 0.5x | BSD-3-Clause | ASGI 服务器 |
| sqlalchemy | 2.x | MIT | ORM |
| pydantic / pydantic-settings | 2.x | MIT | 校验与配置 |
| PyJWT | 2.x | MIT | JWT |
| pillow | 1x | MIT-CMU（HPND 系） | 图片处理 |
| qrcode[pil] | 8.x | BSD | 二维码 |
| httpx | 0.2x | BSD-3-Clause | HTTP 客户端 |
| python-multipart | 0.0.x | Apache-2.0 | 表单上传解析 |
| email-validator | 2.x | Unlicense | 邮箱格式校验 |
| pytest | 9.x | MIT | 测试（不随包分发） |
| PyInstaller | 6.x | GPL-2.0-or-later，含 bootloader 例外 | 打包 sidecar（构建期） |
| Python | 3.13 | PSF-2.0 | 运行时 |

可选依赖（默认未安装）：`psycopg2-binary`（LGPL / PostgreSQL 许可组合，需按实际版本核对）、`boto3`（Apache-2.0）。启用 PostgreSQL 或 S3 时，请把对应许可证补入清单。

## 桌面与移动端

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| tauri / tauri-build | 2.x | MIT 或 Apache-2.0 | 桌面壳 |
| tauri-plugin-notification | 2.x | MIT 或 Apache-2.0 | 通知 |
| tauri-plugin-single-instance | 2.x | MIT 或 Apache-2.0 | 单实例 |
| tauri-plugin-opener | 2.x | MIT 或 Apache-2.0 | 打开外链/目录 |
| serde / serde_json | 1.x | MIT 或 Apache-2.0 | 序列化 |
| base64 | 0.22 | MIT 或 Apache-2.0 | 编码 |
| ureq | 2.x | MIT 或 Apache-2.0 | 本机健康检查 |
| AndroidX / Kotlin / Gradle | 随 SDK | Apache-2.0 等 | Android 构建与运行 |
| WebView2 | 随 Windows | Microsoft 许可 | 桌面 WebView |

Rust 依赖的完整许可证可通过 `cargo about generate about.hbs` 生成；Android 依赖可通过 Gradle 的依赖报告核对。

## 设计参考

### Lens · design-systems

| 项 | 内容 |
| --- | --- |
| 来源 | <https://github.com/ruiqichenbiec/design-systems> |
| 版本 | Lens v1.1.0-showcase.1 |
| 许可证 | MIT |
| 版权 | Copyright © 2026 DayDreamInAReverie |
| 用途 | `frontend/src/lens.css` 的颜色、材质、圆角与控件几何参考 |

HomeLedger 没有引入该仓库的 WebGL2 渲染器、合成音、演示页 HTML、图片或字体。`lens.css` 是针对本项目 DOM 重写的原创 CSS；来源与版权声明保留在文件头。

MIT 许可证全文：

```text
MIT License

Copyright (c) 2026 DayDreamInAReverie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 分发清单

分发安装包或镜像时，至少保留：

1. 本项目的 `LICENSE`、`NOTICE` 和 `EULA.md`；
2. 上表组件的版权声明与许可证文本；
3. Apache-2.0 组件的 `NOTICE`（如有）；
4. 你自行添加的依赖所要求的声明。

如果发现清单遗漏或许可证不兼容，请通过 GitHub Issues 联系维护者。
