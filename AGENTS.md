# Repository Guidelines

## 项目结构与模块组织
`src/` 是运行时代码入口。`src/config/` 负责环境变量与 MongoDB 连接，`src/services/` 包含核心交易流程（`tradeMonitor.ts`、`tradeExecutor.ts`），`src/utils/` 封装 CLOB 客户端、下单、余额查询与数据抓取，`src/models/` 与 `src/interfaces/` 放领域模型与类型定义。`scripts/` 存放安全审计脚本，`dist/` 是编译产物，禁止手改。`test/` 当前主要存放手工验证素材，如 `test/one.jpg`。

## 构建、测试与开发命令
- `npm install`：安装依赖，建议使用 Node.js `>=20.10`。
- `npm run dev`：通过 `ts-node` 直接运行 `src/index.ts`，适合本地联调。
- `npm run build`：将 TypeScript 编译到 `dist/`。
- `npm start`：运行编译后的 `dist/index.js`。
- `npm run lint` / `npm run lint:fix`：执行 ESLint 检查并修复可自动处理的问题。
- `npm run format`：按 Prettier 统一格式化仓库。
- `node validate-bot.js`：执行手工校验脚本，适合改动交易链路前后做快速验证。
- `npm run audit:all`：同时执行 npm 与 OSV 依赖审计。

## 编码风格与命名约定
项目使用 TypeScript + CommonJS。遵循 `.prettierrc`：4 空格缩进、单引号、保留分号、`trailingComma: es5`、`printWidth: 100`。服务与工具文件使用小驼峰命名，例如 `tradeMonitor.ts`、`getMyBalance.ts`；类型与模型文件应与导出领域名保持一致。新增注释、文档与提交信息统一使用简体中文。

## 测试指南
当前 `npm test` 仍是占位脚本，不能作为发布依据。涉及行为变更时，至少提供一轮手工验证：准备 `.env`、启动 MongoDB、运行 `node validate-bot.js`，再执行 `npm run dev` 观察启动日志。若补充自动化测试，优先使用仓库已安装的 Jest + `ts-jest`，测试文件命名为 `*.test.ts`，放在 `src/test/` 或相邻模块目录，并优先 mock Polymarket 与 MongoDB 依赖。

## 提交与 Pull Request 规范
历史提交已出现 `fix(...)`、`fix: ...`、`update: ...`、`style` 等风格；后续建议统一为简体中文 Conventional Commits，例如 `fix(trade): 修复目标钱包筛选`。PR 需说明交易逻辑或安全影响、列出变更过的环境变量、附上执行过的验证命令与结果；只有文档或图片资源变更时再附截图。

## 安全与配置提示
严禁提交 `.env`、私钥、真实钱包地址或生产凭据。请从 `.env-example` 复制配置，并确保 `PRIVATE_KEY` 不带 `0x` 前缀。任何修改下单、余额判断、重试或目标钱包选择逻辑的 PR，都应明确说明风险点与回滚方式。
