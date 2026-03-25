# Repository Guidelines

## 项目结构与模块组织

- `src/index.ts` 是入口，负责连接 MongoDB、创建执行器并启动监视与执行流程。
- `src/config` 管理环境变量与数据库连接；`src/services` 放订阅、监控、执行与结算回收；`src/models` 放 MongoDB 模型；`src/utils` 放 CLOB、日志、确认与规划工具；`src/interfaces` 放共享类型。
- `scripts/` 存放审计与汇总脚本，`docs/` 存放运行说明和配置文档，`.env-example` 用作配置模板。

## 构建、测试与开发命令

- `npm run dev`：通过 `tsx src/index.ts` 启动机器人。
- `npm run format`：按 Prettier 规则格式化全仓库。
- `npm run report:summary`、`npm run audit:osv`：生成执行汇总、执行依赖安全扫描。

## 安全与配置提示

- 严禁提交 `.env`、`.env.live`、私钥或钱包密钥。
- 严禁使用`npx tsc --noEmit` 命令