# Repository Guidelines

## 项目结构与模块组织

- `src/index.ts` 只负责 CLI 参数解析与启动 `ApplicationContext`。
- `src/bootstrap` 负责容器创建、依赖注册与应用启动装配；这里是唯一允许集中组装依赖的地方。
- `src/application` 负责 worker、workflow 编排、启动流程与应用级服务，不直接承担底层协议细节。
- `src/config` 负责 `.env` 读取、Zod 校验、配置归一化；业务代码禁止直接读取 `process.env`。
- `src/domain` 负责领域模型、共享类型、工作流节点协议、策略定义与纯业务规则；共享结构统一放 `src/domain/types`，不要恢复 `model` 这类泛化命名。
- `src/infrastructure` 负责数据库、链上、Polymarket API、网关与外部系统适配。
- `src/application/workflow` 负责派发组装、执行持久化计划等工作流编排逻辑。
- `src/utils` 仅保留无状态、可复用、跨模块的纯工具函数；带业务语义的逻辑必须回收到 `domain`、`application` 或 `infrastructure`。
- `scripts/` 存放审计与汇总脚本，`docs/` 存放运行说明和配置文档，`.env-example` 用作配置模板。

## 构建、测试与开发命令

- `npm run dev`：通过 `tsx src/index.ts` 启动机器人。
- `npm run format`：按 Prettier 规则格式化全仓库。
- `npm run check:imports`：检查 `src/` 下相对导入是否失效。
- `npm test -- --runInBand`：Jest 单线程执行，适合重构后快速定位失败点。
- `npm run check:quick`：提交前最低要求，等价于导入检查 + 单元测试。


## 重复模式与禁止再犯的习惯问题

- 禁止在业务代码或基础设施模块中直接使用 `process.env`。
- 禁止在非装配层手工 `new` 跨模块依赖；依赖统一通过 Awilix 容器或显式工厂注入。
- 禁止继续新增 `createXxx/createYyy` 式多层胶水入口来替代容器注册。
- 禁止把“策略选择”“节点注册”“工作流定义”混在一个类里。
- 禁止在测试中散写超大配置字面量；优先复用 `src/__tests__/testFactories.ts`。
- 路径导入统一使用路径别名。
- 禁止为过渡方便重新引入 `AppConfig`、领域共享类型或策略结果对象的镜像别名文件。
- 禁止把派发、风控、市场范围、快照、执行持久化这类业务逻辑继续堆回 `src/utils` 根目录。
- 禁止把盘口规划、resolved 市场查询、Gamma/CLOB 结果归并这类逻辑继续放进 `src/utils`。

## 命名规范

- 容器入口统一使用 `ApplicationContext`、`*Registry`、`*Catalog`、`*Factory`、`*Bootstrap` 这类职责明确命名。
- 策略实现类保留 `*CopyTradeStrategy` 命名，且只描述策略，不负责节点实例化。
- worker、workflow、gateway、store 名称必须体现职责边界，避免 `service` 泛化。
- 布尔配置使用肯定式命名，如 `autoRedeemEnabled`、`liveSettlementOnchainRedeemEnabled`。

## 推荐依赖选择原则

- 先选成熟库解决基础设施问题：DI 用 `awilix`，配置校验用 `zod`，env 读取用 `dotenv`。
- 只有当库不能覆盖需求，且手写逻辑足够短、边界足够清晰时，才允许自己实现。
- 引库必须服务于收敛：减少胶水、减少重复、减少状态分散，而不是制造新抽象层。

## 类型治理原则

- 配置类型以 `AppConfig` 为唯一事实源；历史别名只能作为过渡，不得继续扩散。
- 领域共享类型只能保留一份事实源；同名类型不得在 `domain/types`、`domain/strategy`、`infrastructure/dto` 之间重复声明。
- 节点上下文只允许依赖 `WorkflowRuntime`；只有应用启动层才允许依赖 `ApplicationRuntime`。
- `Runtime` 风格的大对象禁止重新回流到节点和测试夹具中；新增依赖优先加到更窄的 runtime 接口或专用 port。
- 优先使用 `Pick` / `Partial` / 专用接口表达依赖最小面，避免把整份大对象传遍全链路。
- 新增字段时，必须同步更新配置 schema、测试工厂和相关 mock。
- DTO、领域模型、数据库模型要分清用途；能复用同一语义模型时不再额外包一层 wrapper。

## 边界约束

- `domain` 不直接依赖 `process`、数据库模型或网络 SDK。
- `infrastructure` 不负责业务策略选择。
- `application` 可以编排 `domain + infrastructure`，但不应重新实现领域规则。
- 容器注册阶段允许集中实例化；模块实现阶段应保持无副作用、可测试。

## 测试与类型检查注意事项

- 提交前至少执行一次 `npm run check:quick`。
- 严禁使用 `npx tsc --noEmit`、`tsc --noEmit`。
- 需要验证改动正确性时，优先使用“导入检查 + 单元测试”的轻量校验路径；如需补充类型约束，使用局部测试和编译约束替代全量 `tsc`。

## 安全与配置提示

- 严禁提交 `.env`、`.env.live`、私钥或钱包密钥。
- 涉及钱包、签名、链上交易的改动，必须先确认 `live` 与 `paper` 模式边界没有被混淆。
