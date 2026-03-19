# Repository Guidelines

## 项目结构与模块组织

- `src/index.ts` 是入口，负责连接 MongoDB、创建执行器并启动监视与执行流程。
- `src/config` 管理环境变量与数据库连接；`src/services` 放订阅、监控、执行与结算回收；`src/models` 放 MongoDB 模型；`src/utils` 放 CLOB、日志、确认与规划工具；`src/interfaces` 放共享类型。
- `scripts/` 存放审计与汇总脚本，`docs/` 存放运行说明和配置文档，`.env-example` 用作配置模板。

## 构建、测试与开发命令

- `npm run dev`：通过 `tsx src/index.ts` 启动机器人。
- `npm run format`：按 Prettier 规则格式化全仓库。
- `npm run report:summary`、`npm run audit:osv`：生成执行汇总、执行依赖安全扫描。

## 编码风格与命名约定

- TypeScript 开启 `strict`；统一 4 空格缩进、单引号、保留分号、行宽 100，以 Prettier 为准。
- 文件名延续现有 `camelCase` 风格，如 `tradeMonitor.ts`、`liveSettlementReclaimer.ts`。
- 新增注释、文档和提交说明统一使用简体中文；配置项与运行模式沿用既有命名，如 `trace`、`live`、`AUTO_REDEEM_ENABLED`。

## 测试与验证规范

- `validate-bot.js`，适合做启动前冒烟检查，不等同于完整单元测试。
- 修改执行链路、风控或环境变量时，至少提供一次对应模式下的验证命令与结果。
- 新增复杂策略逻辑时，优先补充可自动运行的校验脚本或定向测试，而不是只做手工联调。

## 提交与 Pull Request 规范

- 提交信息遵循仓库已有风格：`feat(executor): ...`、`fix(ws): ...`、`refactor(config): ...`。
- 推荐格式为 `type(scope): 简体中文摘要`，一次提交聚焦一个主题。
- PR 需说明影响模式（`trace`/`live`）、配置变更、验证命令，以及执行链路改动带来的风险；涉及下单或回收逻辑时，附关键日志或汇总片段。

## 安全与配置提示

- 严禁提交 `.env`、`.env.live`、私钥或钱包密钥。