# Repository Guidelines

## 项目结构与模块组织

- `src/index.ts` 是入口，负责连接 MongoDB、创建执行器并启动监视与执行流程。
- `src/config` 管理环境变量与运行参数；`src/domain` 放工作流节点、策略与核心领域模型；`src/infrastructure` 放链上、数据库、Polymarket 接口与运行时装配；`src/utils` 放日志、解析与通用计算工具。
- `scripts/` 存放审计与汇总脚本，`docs/` 存放运行说明和配置文档，`.env-example` 用作配置模板。

## 构建、测试与开发命令

- `npm run dev`：通过 `tsx src/index.ts` 启动机器人。
- `npm run format`：按 Prettier 规则格式化全仓库。

## 测试与类型检查注意事项

- 提交前至少执行一次 `npm run check:quick`（等价于导入检查 + `npm test`）。
- 严禁使用 `npx tsc --noEmit`、`tsc --noEmit`（全量类型检查内存占用高、耗时长）。
- 需要验证改动正确性时，优先使用“导入检查 + 单元测试”的轻量校验路径；如需补充类型约束，使用局部测试和编译约束替代全量 `tsc`。

## 安全与配置提示

- 严禁提交 `.env`、`.env.live`、私钥或钱包密钥。