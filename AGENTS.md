# Repository Guidelines

## 项目结构与模块组织

- `src/index.ts` 只负责 CLI 参数解析与启动 `ApplicationContext`。
- `src/bootstrap` 负责容器创建、依赖注册与应用启动装配；这里是唯一允许集中组装依赖的地方。
- `src/application` 负责 worker、workflow 编排、启动流程与应用级服务，不直接承担底层协议细节。
- `src/config` 负责 `.env` 读取、Zod 校验、配置归一化；业务代码禁止直接读取 `process.env`。
- `src/domain` 负责领域模型、工作流节点协议、策略定义与纯业务规则。
- `src/infrastructure` 负责数据库、链上、Polymarket API、网关与外部系统适配。
- `src/utils` 仅保留无状态、可复用、跨模块的纯工具函数；禁止继续新增模糊 `helpers` / `wrapper` / `shared` 式目录。
- `scripts/` 存放审计与汇总脚本，`docs/` 存放运行说明和配置文档，`.env-example` 用作配置模板。

## 构建、测试与开发命令

- `npm run dev`：通过 `tsx src/index.ts` 启动机器人。
- `npm run format`：按 Prettier 规则格式化全仓库。
- `npm run check:imports`：检查 `src/` 下相对导入是否失效。
- `npm test -- --runInBand`：Jest 单线程执行，适合重构后快速定位失败点。
- `npm run check:quick`：提交前最低要求，等价于导入检查 + 单元测试。

## 本次发现的编码问题

- 入口装配散落在 `main/createRuntime/createApp`，导致依赖图不透明、手工 `new` 过多。
- 配置解析曾分散在手写 env 工具与若干模块顶层逻辑中，缺少统一 schema 与条件校验。
- `logger` 曾直接读取 `process.env`，导致全局状态与测试环境强耦合。
- 策略层曾同时负责“节点注册 + 工作流描述”，导致策略与装配耦合。
- 测试侧长期复制整份大配置对象和 runtime mock，噪音高且容易遗漏新增字段。
- 目录中存在历史胶水入口与低价值兼容层，增加了双事实源风险。

## 重复模式与禁止再犯的习惯问题

- 禁止在业务代码或基础设施模块中直接使用 `process.env`。
- 禁止在非装配层手工 `new` 跨模块依赖；依赖统一通过 Awilix 容器或显式工厂注入。
- 禁止继续新增 `createXxx/createYyy` 式多层胶水入口来替代容器注册。
- 禁止新增 `helpers`、`wrapper`、`shared` 这类语义空泛命名；必须用职责名命名。
- 禁止把“策略选择”“节点注册”“工作流定义”混在一个类里。
- 禁止在测试中散写超大配置字面量；优先复用 `src/__tests__/testFactories.ts`。
- 禁止恢复深层相对路径导入；统一使用路径别名。

## 命名规范

- 容器入口统一使用 `ApplicationContext`、`*Registry`、`*Catalog`、`*Factory`、`*Bootstrap` 这类职责明确命名。
- 策略实现类保留 `*CopyTradeStrategy` 命名，且只描述策略，不负责节点实例化。
- worker、workflow、gateway、store 名称必须体现职责边界，避免 `service` 泛化。
- 布尔配置使用肯定式命名，如 `autoRedeemEnabled`、`liveSettlementOnchainRedeemEnabled`。

## 推荐依赖选择原则

- 先选成熟库解决基础设施问题：DI 用 `awilix`，配置校验用 `zod`，env 读取用 `dotenv`。
- 只有当库不能覆盖需求，且手写逻辑足够短、边界足够清晰时，才允许自己实现。
- 引库必须服务于收敛：减少胶水、减少重复、减少状态分散，而不是制造新抽象层。
- 禁止为了“看起来像某框架”而引入与当前项目形态不匹配的库，例如无 HTTP 面时引入 HTTP 路由装配库。

## 目录职责

- `bootstrap`：唯一应用装配入口。
- `application`：应用级编排与生命周期。
- `config`：配置加载、校验、归一化。
- `domain`：领域规则与核心模型。
- `infrastructure`：外部依赖适配。
- `utils`：纯工具函数。
- `__tests__`：测试与测试工厂。

## 类型治理原则

- 配置类型以 `AppConfig` 为唯一事实源；历史别名只能作为过渡，不得继续扩散。
- `Runtime` 只保留运行所需的最小共享依赖集合，禁止继续无限膨胀。
- 优先使用 `Pick` / `Partial` / 专用接口表达依赖最小面，避免把整份大对象传遍全链路。
- 新增字段时，必须同步更新配置 schema、测试工厂和相关 mock。
- DTO、领域模型、数据库模型要分清用途；能复用同一语义模型时不再额外包一层 wrapper。

## 配置治理原则

- `.env` 读取只能发生在 `src/config`。
- 所有 env 字段必须在 Zod schema 中声明默认值、枚举约束或条件必填逻辑。
- 未被代码使用的 env 参数要删除，不保留历史兼容壳。
- `.env-example` 必须与当前 `AppConfig` 保持一致；删除字段时同步删除示例与注释。
- 日志配置同样视为应用配置的一部分，不允许模块顶层静态读取。

## 边界约束

- `domain` 不直接依赖 `process`、数据库模型或网络 SDK。
- `infrastructure` 不负责业务策略选择。
- `application` 可以编排 `domain + infrastructure`，但不应重新实现领域规则。
- 容器注册阶段允许集中实例化；模块实现阶段应保持无副作用、可测试。

## 变更前必须检查的事项

- 是否已有可复用的配置字段、测试工厂、容器注册项，而不是重复新增一套。
- 是否会引入第二个装配入口、第二份状态源或第二套配置读取路径。
- 是否把相对导入写成了路径别名。
- 是否新增了未被使用的 env、DTO、类型、wrapper 或兼容分支。
- 是否影响 `npm run check:imports`、`npm test -- --runInBand`、`npm run check:quick`。
- 如果改动涉及策略、节点、worker、配置字段，是否同步更新测试夹具与文档。

## 测试与类型检查注意事项

- 提交前至少执行一次 `npm run check:quick`。
- 严禁使用 `npx tsc --noEmit`、`tsc --noEmit`。
- 需要验证改动正确性时，优先使用“导入检查 + 单元测试”的轻量校验路径；如需补充类型约束，使用局部测试和编译约束替代全量 `tsc`。

## 安全与配置提示

- 严禁提交 `.env`、`.env.live`、私钥或钱包密钥。
- 涉及钱包、签名、链上交易的改动，必须先确认 `live` 与 `paper` 模式边界没有被混淆。
