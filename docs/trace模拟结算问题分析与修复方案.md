# trace 模拟结算问题分析与修复方案

## 1. 分析范围

- 分析时间：2026-03-20
- 数据源：
    - 本地 MongoDB `polymarket_copytrading`
    - trace 命名空间：`default`
    - 源钱包：`0xb27bc932bf8110d8f78e55da7d5f0497a18b5b82`
- 本次重点核对了 `2026-03-19` 的 11 个 `Bitcoin Up or Down` 已结算市场，并逐一对照 Polymarket 实际市场页面的最终 winner。

## 2. 关键结论

### 2.1 当前 trace 账本明显高估收益

- 本地账本：
    - `cashBalance = 486.612540 USDC`
    - `positionsMarketValue = 630.058081 USDC`
    - `totalEquity = 1116.670621 USDC`
    - `netPnl = +116.670621 USDC`
    - `realizedPnl = 0`
- 按这 11 个市场的实际结算结果重算后：
    - `expectedPositionValue = 521.662125 USDC`
    - `expectedFinalEquity = 1008.274665 USDC`
    - `expectedNetPnl = +8.274665 USDC`
- 结论：
    - 当前 trace 组合权益被高估了 `108.395956 USDC`
    - 本地账本把大量应当失效的失败边仓位继续计入了权益

### 2.2 本地根本没有发生自动结算

- `trace_executions_*` 共 `1490` 条
- `executionCondition = settle` 的记录数为 `0`
- 说明 trace 账本虽然设计了自动结算逻辑，但在本批数据里完全没有成功落账

### 2.3 trace 持仓价格已经失真，不满足二元市场基本约束

- 11 个已结算 condition 里，10 个市场出现了明显异常
- 典型异常：
    - 同一个二元市场两边价格都等于 `1`
    - 同一个二元市场两边价格都等于 `0.0005`
    - 同一个二元市场两边价格和不等于 `1`，例如 `0.97 + 0.175 = 1.145`
- 这不是 Polymarket 二元市场的正常状态，说明 trace 的 outcome 对价同步存在串边或兜底错配

### 2.4 当前策略并没有真正“跟上”源账户

- `1490` 条 trace 执行中只有 `250` 条 `FILLED`
- `1240` 条是 `SKIPPED`
- 主要跳过原因：
    - `1049` 次：累计金额小于 `1 USDC` 最小门槛
    - `148` 次：当前买价超出允许滑点
    - `36` 次：补齐到 `1 USDC` 后仍然超滑点
- 这意味着当前 trace 更接近“抽样跟单”，而不是“真实复制”

## 3. 根因拆解

### 3.1 `MERGE` / `REDEEM` 被监控层直接判成 `SYNC_ONLY`

- 代码位置：
    - `src/services/tradeMonitor.ts:54`
    - `src/services/tradeMonitor.ts:281`
    - `src/services/paperTradeExecutor.ts:677`
- 当前行为：
    - 只有 `type = TRADE` 会进入 `EXECUTE`
    - `MERGE` / `REDEEM` 被统一标记为 `SYNC_ONLY`，默认 `botStatus = SKIPPED`
    - `paperTradeExecutor` 只会消费 `type = TRADE`
- 实际数据：
    - 本次 11 个 condition 对应的源活动里有：
        - `TRADE / EXECUTE / PENDING = 6061`
        - `MERGE / SYNC_ONLY / SKIPPED = 165`
        - `REDEEM / SYNC_ONLY / SKIPPED = 11`
- 影响：
    - 源账户已经在 merge/redeem，trace 账本却完全没有执行对应的出场或结算

### 3.2 自动结算错误地依赖“源钱包当前持仓的 redeemable”

- 代码位置：
    - `src/services/paperTradeExecutor.ts:49`
    - `src/services/paperTradeExecutor.ts:498`
    - `src/services/paperTradeExecutor.ts:606`
    - `src/services/paperTradeExecutor.ts:1480`
- 当前逻辑：
    - trace 空闲时读取 `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}&sizeThreshold=0`
    - 只有当匹配到的源持仓上存在 `redeemable = true` 时，才把本地仓位按 `1 USDC` 结算
- 实际现象：
    - 对这 11 个已结算 condition，再查一次当前 `positions` API，返回的匹配记录为 `0`
- 影响：
    - 一旦源钱包已经 merge/redeem 掉持仓，trace 后续就再也拿不到 `redeemable`
    - 这会导致本地仓位永久停留在“未平但已结算”的错误状态

### 3.3 outcome 价格同步存在 condition 级别兜底错配

- 代码位置：
    - `src/services/paperTradeExecutor.ts:237`
- 当前逻辑：
    - 先按 `asset` 精确匹配
    - 再按 `conditionId + outcome` 匹配
    - 如果都找不到，最后退化为只按 `conditionId` 匹配
- 问题：
    - 同一二元市场里，某一边找不到精确仓位时，可能把另一边的 `curPrice` 或 `redeemable` 套到本地仓位上
- 结果：
    - 本地出现两边同时标成 `1`、同时标成 `0.025` 等不可能状态

### 3.4 本地账本把双边头寸当作独立价值，未进行 condition 级净额处理

- 当前 trace 对同一 condition 下的两个 outcome 独立记账
- 当源账户通过 `MERGE` 把双边仓位合成为现金时，本地没有同步执行对应的冲销
- 结果：
    - 本地会同时保留 winner 与 loser 两边的持仓价值
    - 从而把 condition 总价值算高

## 4. 代表性证据

### 4.1 `Bitcoin Up or Down - March 19, 12:25PM-12:30PM ET`

- 市场链接：<https://polymarket.com/event/btc-updown-5m-1773937500/btc-updown-5m-1773937500>
- 实际 winner：`Up`
- 本地账本：
    - `Up = 31.249122`
    - `Down = 78.964258`
    - 两边都按 `marketPrice = 1` 计值
    - condition 当前市值 `110.213380`
- 按实际结算应只有 winner 一边有效：
    - 真实应值 `31.249122`
- 单个 condition 被高估了 `78.964258`

### 4.2 `Bitcoin Up or Down - March 19, 12:30PM-12:35PM ET`

- 市场链接：<https://polymarket.com/event/btc-updown-5m-1773937800/btc-updown-5m-1773937800>
- 实际 winner：`Down`
- 本地账本：
    - `Up` 与 `Down` 两边都被标成 `0.0005`
    - condition 当前市值只有 `0.046073`
- 按实际结算应值：
    - `43.314010`
- 单个 condition 被低估了 `43.267937`

### 4.3 `Bitcoin Up or Down - March 19, 12:40PM-12:45PM ET`

- 市场链接：<https://polymarket.com/event/btc-updown-5m-1773938400/btc-updown-5m-1773938400>
- 实际 winner：`Up`
- 本地账本：
    - `Up` 与 `Down` 两边都被标成 `0.005`
- 这直接证明本地 outcome 标价已发生串边或失真

## 5. 新增复用脚本

本次已新增：

- 脚本：[scripts/trace-settlement-audit.mjs](/Users/chenzihao/dev/ts/polymarket-copytrading-bot/scripts/trace-settlement-audit.mjs)
- npm 命令：`npm run report:trace-audit`

脚本用途：

- 读取 trace 持仓、执行记录、源活动
- 自动按 `conditionId` 聚合
- 通过源活动里的 `slug/eventSlug` 反查 Polymarket 实际市场页面
- 提取实际 `winner`
- 计算本地当前权益与“按真实结算重算后的权益”偏差
- 输出主要跳过原因、`MERGE/REDEEM` 分布、异常 condition 明细

示例：

```bash
npm run report:trace-audit
```

```bash
npm run report:trace-audit -- --json
```

```bash
node scripts/trace-settlement-audit.mjs --trace-id default --user-address 0xb27bc932bf8110d8f78e55da7d5f0497a18b5b82
```

## 6. 落地修复方案

### 阶段一：先修正确性，再谈收益表现

目标：

- 让 trace 账本先变成“和源账户生命周期一致”
- 不再出现已 resolved 市场长期挂仓、winner/loser 同时计值的问题

改动建议：

1. 让 `MERGE` / `REDEEM` 进入 trace 执行链路
    - 不要再把所有非 `TRADE` 活动统一视为 `SYNC_ONLY`
    - 至少在 trace 模式下，`MERGE` / `REDEEM` 需要被消费并映射成本地仓位调整
2. 拆分 trace 执行入口
    - `TRADE` 继续走现有买卖撮合逻辑
    - `MERGE` 走 condition 级净额回收逻辑
    - `REDEEM` 走 winner 兑付逻辑
3. 修正 `matchUserPosition`
    - 删除“只按 `conditionId` 匹配”的最后兜底
    - 严格限制为：
        - `asset` 精确匹配
        - 或 `conditionId + outcome` 精确匹配
    - 若两者都找不到，则本轮不更新该仓位价格，并记录告警

验收标准：

- 新跑一轮 trace 后，`trace_executions` 中必须能看到 `merge` / `settle` / `redeem` 类流水
- 不再出现两边同时为 `1` 或同时为 `0.0005` 的情况

### 阶段二：把结算触发从“当前持仓接口”改成“事件分辨结果”

目标：

- 不依赖源钱包当前是否还持有该仓位
- 即使源账户已经 merge/redeem 完，也能补齐 trace 账本

改动建议：

1. 引入独立的 market resolution resolver
    - 首选源活动里的 `eventSlug/slug`
    - 再去 Polymarket 市场页读取 `resolved` 和 `winner`
    - 后续可替换成更稳定的官方/准官方 market API
2. 给 trace position 增加结算字段
    - `marketSlug`
    - `resolvedAt`
    - `resolvedWinner`
    - `settlementState`
    - `settlementSource`
3. 空闲轮次的结算流程改为：
    - 先检查本地 open positions 对应市场是否已经 resolved
    - resolved 后直接按 winner 把 loser 清零、winner 兑付到 `1`
    - 记录 `trace_executions.executionCondition = settle`
4. `redeemable` 仅作为辅助信号
    - 不再作为唯一触发条件

验收标准：

- 即使源钱包 `positions` API 对已结算 condition 返回 `0` 条，本地 trace 也能自动落结算
- `realizedPnl` 会随结算增长，不再长期停留在 `0`

### 阶段三：补齐 condition 级净额模型

目标：

- 正确反映同一二元市场双边持仓的经济含义

改动建议：

1. 在 trace 中引入 condition 级视图
    - 统计同一个 `conditionId` 下的 `Up/Down`
    - 支持计算可 merge 份额 `min(size_up, size_down)`
2. 执行 `MERGE` 时：
    - 以本地两边最小持仓为可 merge 数量
    - 同步减少双方仓位
    - 增加现金余额
    - 记录 merge 流水
3. 对 resolved 市场：
    - loser 直接作废
    - winner 按份额兑付到 `1`

验收标准：

- 已 resolved 的二元市场，condition 总价值应只等于 winner 的本地份额
- 不再出现“winner + loser 同时贡献权益”的现象

### 阶段四：再处理跟上率问题

目标：

- 在账本正确的前提下，再提升复制质量

改动建议：

1. 重新评估 `1 USDC` 最小单阈值
    - 高频 5 分钟市场下，当前累计窗口过于容易产生大量 dust skip
2. 细分市场类型
    - 对 `BTC Up/Down 5m` 这类高频小额市场，使用更贴近场景的最小跟单策略
3. 输出跟上率指标
    - condition 级跟上率
    - source trade -> local fill 映射率
    - 因最小单门槛导致的跳过比例
    - 因滑点导致的跳过比例

## 7. 推荐实施顺序

1. 先改 `MERGE/REDEEM` 的执行意图与消费入口
2. 再把结算从 `redeemable` 切换到独立 resolver
3. 然后修 `matchUserPosition` 的 condition 级兜底错配
4. 最后再调优最小单与滑点策略

## 8. 验证建议

每做完一阶段，至少执行一次：

```bash
npm run report:trace-audit -- --json
```

重点观察：

- `settleFilledCount` 是否大于 `0`
- `equityDeltaVsCurrent` 是否明显收敛
- `impossibleBinaryPriceCount` 是否降到 `0`
- `MERGE / REDEEM` 是否不再全部停留在 `SYNC_ONLY / SKIPPED`
