# 贡献指南

感谢你愿意改进 HomeLedger。这个项目是本地优先的家庭物品台账，代码、数据和部署都属于使用者；提交改动前，请先确认它符合这个方向。

## 先讨论，再动手

- 修 bug、补文档、改错别字：可以直接提 Pull Request。
- 新功能、数据模型变更、权限模型变更、依赖替换：请先开 Issue 说明场景和方案，避免做完才发现方向不一致。
- 安全漏洞：不要公开提 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。
- 商业授权相关：见 [COMMERCIAL.md](COMMERCIAL.md)，不要通过 PR 夹带商业功能。

## 开发环境

需要：

- Python 3.11+（推荐 3.12/3.13）
- Node.js 20+ 与 pnpm 10+
- Rust 1.77+（只改前端/后端时可不装）
- 构建桌面端需要 Tauri 2 的系统依赖；构建 Android 需要 JDK 17、Android SDK 与 NDK

### 一键开发

```bash
git clone https://github.com/Bronsan/HomeLedger.git
cd HomeLedger
./deploy/dev.sh
```

脚本会创建后端虚拟环境、安装依赖，并同时启动后端 `8000` 与前端 `5173`。首次启动会自动建表。

### 手动启动

```bash
# 后端
cd backend
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m app.migrate
uvicorn app.main:app --reload    # http://127.0.0.1:8000/api/docs

# 前端（另开终端）
cd frontend
pnpm install
pnpm dev                         # http://127.0.0.1:5173，代理到 8000
```

生产构建：

```bash
cd frontend
pnpm build                       # 产物写入 backend/app/static/
```

桌面端与 Android 的出包命令见 [docs/PACKAGING.md](docs/PACKAGING.md)。Windows 上如果 Tauri 无法创建 jniLibs 符号链接，按该文档的 Gradle 回退步骤处理。

## 测试

```bash
# 后端
cd backend
python -m pytest

# 前端单元测试
cd frontend
pnpm test

# 浏览器端到端测试（需要 Playwright 可用的 Chromium/Edge）
pnpm e2e
```

测试使用临时数据目录，不会写入 `backend/data/`。如果你要自己写测试，请通过 `HOMELEDGER_DATA_DIR` 指向临时目录，并为每个用例使用独立家庭（租户）隔离。不要把真实家庭数据、真实邮箱、密码或密钥放进测试夹具。

提交前至少运行：

- `python -m pytest`
- `pnpm test`
- `pnpm build`（TypeScript 类型检查 + 生产构建）

改动涉及同步、备份、权限或数据库迁移时，请补充对应测试，并在 PR 描述里说明迁移与回滚方式。

## 代码风格

- 前端：TypeScript + React 函数组件；沿用现有页面结构和 CSS 变量，不引入新的大型 UI 框架。
- 后端：FastAPI + SQLAlchemy 2.0；路由只做参数校验和编排，业务逻辑放在 `services/`。
- 数据库迁移：新增迁移文件，不修改已发布的旧迁移；保证 SQLite 与 PostgreSQL 都能运行，或明确标注只支持其中一种。
- 权限：默认拒绝；新增接口必须声明所需权限，并补充越权测试。
- 错误信息：面向用户，说明发生了什么和怎么处理；不要泄露堆栈、路径或密钥。
- 注释：解释“为什么”，不要复述代码。中文和英文都可以，同一文件内保持一致。

## 提交与 PR

- 一个 PR 只做一件事；避免把格式化、重命名和功能改动混在一起。
- 提交信息建议使用 `type(scope): summary`，例如 `fix(sync): 修复断网后队列卡住`。
- PR 描述请包含：问题、方案、测试结果、截图（界面改动）、风险与回滚方式。
- 不要提交 `node_modules`、`.venv`、`dist/`、`build/`、`backend/data/`、`backend/app/static/`、签名证书、私钥、`.env` 或本地日志。
- 不要提交从他人仓库复制来的代码、图片、字体或设计资源，除非许可证兼容并在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 中注明。
- 界面改动请附亮色/暗色截图，并确认没有横向溢出、键盘可操作、焦点可见。

## 贡献许可

本项目采用 PolyForm Noncommercial 1.0.0，并提供单独的商业授权。为了让项目能够持续维护和双轨授权，提交贡献即表示你同意：

1. 你的贡献按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权；
2. 你授予维护者（Bronsan）一项永久的、全球范围的、非排他的、免费的、不可撤销的许可，可以复制、修改、分发、再许可你的贡献，包括以商业授权方式使用；
3. 你确认自己有权提交该贡献，且贡献不侵犯第三方的版权、专利、商标或其他权利。

如果你不同意上述条款，请不要提交贡献。你在 Issue 中提出的想法、建议和反馈，不视为代码贡献，但维护者可以自由采用。

## 行为准则

参与项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 联系方式

- 一般问题与功能建议：GitHub Issues
- 安全问题：<https://github.com/Bronsan/HomeLedger/security/advisories/new>
- 商业授权：见 [COMMERCIAL.md](COMMERCIAL.md)
