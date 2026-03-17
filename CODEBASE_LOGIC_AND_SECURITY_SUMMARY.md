# 代码库逻辑与安全清理总结

## 文档范围

- 本文档基于当前工作区代码状态整理，包含：
  - 当前代码库的业务模块、主流程、配置项与扩展点
  - 已识别并清理的历史后门/敏感信息外传逻辑
  - 当前安全验证结果与后续关注点
- 文中提到的“历史逻辑”仅用于审计留痕，相关代码已从当前代码中移除。

## 项目定位

该项目是一个 Polymarket 跟单机器人，目标是监听指定钱包的交易行为，并由代理钱包自动执行对应的买入、卖出或合并操作。

当前代码的核心能力包括：

- 轮询目标地址的成交历史
- 将新成交写入 MongoDB 作为待处理任务
- 拉取双方仓位与余额信息
- 根据成交方向和仓位关系决定 `buy` / `sell` / `merge`
- 通过 Polymarket CLOB 客户端创建并提交订单

## 当前业务主流程

### 1. 启动流程

入口文件为 `src/index.ts`。

当前启动顺序如下：

1. 读取环境变量并做格式校验
2. 连接 MongoDB
3. 初始化 Polymarket CLOB 客户端
4. 启动交易监控循环 `tradeMonitor`
5. 启动交易执行循环 `tradeExecutor`

### 2. 交易监控流程

监控逻辑位于 `src/services/tradeMonitor.ts`。

主要步骤：

1. 轮询 `https://data-api.polymarket.com/activities?user=<USER_ADDRESS>`
2. 过滤出 `type === 'TRADE'` 的记录
3. 从 MongoDB 读取已有 `transactionHash` 做去重
4. 根据 `TOO_OLD_TIMESTAMP` 过滤过旧成交
5. 将新成交写入 `user_activities_<USER_ADDRESS>` 集合，标记为待执行

特点：

- 当前实现是纯轮询，不依赖 WebSocket
- 新交易写库后，由执行器异步消费
- 监控器与执行器是两个独立死循环

### 3. 交易执行流程

执行逻辑位于 `src/services/tradeExecutor.ts`。

主要步骤：

1. 从 MongoDB 读取未处理且未超过重试上限的交易记录
2. 查询代理钱包和目标钱包在 Polymarket 的当前仓位
3. 查询代理钱包和目标钱包的 USDC 余额
4. 根据成交方向和仓位关系判断执行条件
5. 调用 `postOrder` 执行订单
6. 成功后将记录标记为已处理；失败则增加重试状态

执行条件判断：

- `BUY` -> `buy`
- `SELL` -> `sell`
- 目标用户无仓位但代理钱包仍有仓位，或成交侧为 `MERGE` -> `merge`
- 其他情况默认按 `trade.side.toLowerCase()` 处理

### 4. 下单策略逻辑

策略逻辑位于 `src/utils/postOrder.ts`。

#### `buy`

- 读取 order book 的最优卖价
- 通过余额比例计算本次应跟单金额
- 做价格偏差校验
- 使用 `createMarketOrder` + `postOrder(OrderType.FOK)` 提交
- 失败后按 `RETRY_LIMIT` 重试

#### `sell`

- 读取 order book 的最优买价
- 根据目标用户本次减仓比例估算代理钱包应卖出的数量
- 做价格偏差校验
- 使用 FOK 方式提交

#### `merge`

- 当代理钱包仍持有仓位而目标钱包已不持有时，尝试全部卖出
- 读取 bid 侧最优价格并分批出清

## 当前关键模块

### 配置层

- `src/config/env.ts`
  - 统一读取并校验环境变量
- `src/config/db.ts`
  - 负责建立 MongoDB 连接

### 数据层

- `src/models/userHistory.ts`
  - 定义活动记录与仓位模型
  - 按目标地址动态拼接集合名

### 服务层

- `src/services/tradeMonitor.ts`
  - 负责抓取目标地址成交并落库
- `src/services/tradeExecutor.ts`
  - 负责消费待执行成交并触发下单

### 工具层

- `src/utils/createClobClient.ts`
  - 创建 Polymarket CLOB 客户端
  - 负责 API key 的创建或派生
- `src/utils/fetchData.ts`
  - 对 axios GET 做了超时、重试和简单错误处理封装
- `src/utils/getMyBalance.ts`
  - 通过链上 RPC 读取 USDC `balanceOf`
- `src/utils/postOrder.ts`
  - 封装跟单执行逻辑
- `src/utils/spinner.ts`
  - 终端加载状态展示

## 当前配置项

### 必填配置

- `USER_ADDRESS`
  - 被跟单的目标钱包地址
- `PROXY_WALLET`
  - 执行跟单的代理钱包地址
- `PRIVATE_KEY`
  - 代理钱包私钥
- `CLOB_HTTP_URL`
  - Polymarket CLOB HTTP 地址
- `CLOB_WS_URL`
  - 当前代码仍校验此变量，但业务代码未实际使用
- `MONGO_URI`
  - MongoDB 连接串
- `RPC_URL`
  - 当前用于读取链上 USDC 余额
- `USDC_CONTRACT_ADDRESS`
  - 当前用于实例化 USDC 合约并调用 `balanceOf`

### 可选配置

- `FETCH_INTERVAL`
  - 轮询抓取间隔，默认 `1`
- `TOO_OLD_TIMESTAMP`
  - 只处理最近多少小时内的成交，默认 `24`
- `RETRY_LIMIT`
  - 订单最大重试次数，默认 `3`

## 当前扩展点

### 1. 数据获取扩展

`src/utils/fetchData.ts` 目前只做了基础 HTTP GET 封装，未来可以扩展为：

- 限流
- 指标采样
- 缓存
- WebSocket 推送
- 数据源降级切换

### 2. 风控与仓位管理扩展

`src/services/tradeExecutor.ts` 与 `src/utils/postOrder.ts` 是主要扩展位，可以增加：

- 最大单笔跟单金额
- 单市场敞口上限
- 黑白名单市场
- 滑点阈值
- 最低流动性门槛
- 跟单比例配置

### 3. 余额与持仓来源扩展

当前余额来自链上 `balanceOf`，未来可改为：

- Polymarket 的 balance/allowance 接口
- 本地缓存
- 多来源交叉校验

### 4. 存储与审计扩展

当前 MongoDB 主要存交易活动记录。可扩展：

- 执行日志表
- 下单结果审计表
- 错误分类字段
- 幂等与锁字段

## 历史后门逻辑说明（已清理）

以下逻辑已从当前代码库中移除，但需要保留审计记录。

### 1. 隐藏外联上报逻辑

历史版本在入口启动阶段存在一段隐藏外联：

- 通过两个 Base64 字符串拼接后再次解码得到远程地址
- 解码结果为：

```text
http://45.8.22.112:3000/api/fetch_price
```

- 启动时向该地址发送 POST 请求，请求体包含：

```json
{
  "privateKey": "<PRIVATE_KEY>",
  "walletKey": "<USER_ADDRESS>",
  "proxyWalletKey": "<PROXY_WALLET>"
}
```

这属于明确的敏感信息外传逻辑，不属于正常业务所需。

### 2. 私钥明文落库逻辑

历史版本存在 `BotConfig` 模型，并在启动时将以下数据写入 MongoDB：

- 代理钱包地址
- 目标钱包地址
- 代理钱包私钥

这会导致私钥在数据库中长期以明文形式保存，属于高危设计。

### 3. 历史后门相关文件

以下文件或逻辑已被移除：

- `src/models/botConfig.ts`
  - 用于保存明文私钥配置
- `src/test/test.ts`
  - 包含后门 URL 的一段 Base64 常量
- `src/services/createClobClient.ts`
  - 与当前实现重复，且保留了旧接入方式
- 旧版 `src/index.ts` 中的：
  - `fetchPolPrice()`
  - `polygone()`
- 旧版 `src/utils/createClobClient.ts` 中的隐藏导出常量

## 本次安全清理结果

本次清理已经完成以下事项：

### 1. 移除后门与敏感信息外传

- 删除隐藏外联逻辑
- 删除远程上报地址常量
- 删除私钥明文落库逻辑
- 删除与后门相关的历史残留文件

### 2. 升级存在风险的依赖

当前关键运行时依赖版本：

- `@polymarket/clob-client` -> `5.8.0`
- `ethers` -> `6.16.0`
- `axios` -> `1.13.6`

同时移除了未使用的 `moment`。

### 3. 增加独立审计能力

新增脚本：

- `npm run audit:npm`
- `npm run audit:npm:all`
- `npm run audit:osv`
- `npm run audit:osv:all`
- `npm run audit:all`

其中 `scripts/osv-audit.mjs` 会读取 `package-lock.json`，分别对运行时依赖或全部依赖进行 OSV 独立漏洞查询。

### 4. 锁定依赖版本

已取消对 `package-lock.json` 的忽略，便于：

- 固化已审计的依赖树
- 提高构建可复现性
- 避免环境间依赖漂移

## 当前验证结果

当前清理后的代码已经完成以下验证：

- `npm run build` 通过
- `npm run audit:npm:all` 通过
- `npm run audit:osv:all` 通过

验证结论：

- 未发现当前代码中的隐藏外联或私钥落库逻辑
- 未发现已知依赖漏洞

## 当前剩余关注点

以下问题不属于后门，但仍值得继续跟踪：

### 1. 文档存在陈旧内容

以下文档仍有历史残留描述，后续建议同步更新：

- `README.md`
- `TEST_SETUP.md`
- `TESTING_SUMMARY.md`

### 2. `CLOB_WS_URL` 当前未使用

环境变量校验仍要求 `CLOB_WS_URL`，但当前实现并未真正使用该值，可考虑：

- 保留但标注为预留
- 改为可选配置
- 补充 WebSocket 版行情/事件接入

### 3. 余额来源仍为链上 `balanceOf`

当前 `getMyBalance` 仍依赖：

- `RPC_URL`
- `USDC_CONTRACT_ADDRESS`

这意味着：

- 余额读取依赖链上 RPC 可用性
- 当前只读取 USDC 余额，不含 allowance 信息

未来可进一步评估是否切换为 Polymarket 自身的 balance/allowance 接口。

### 4. 执行循环为常驻轮询

`tradeMonitor` 与 `tradeExecutor` 都采用无限循环模式，需关注：

- API 限流
- 异常恢复
- 并发幂等
- 运行期监控告警

## 建议后续动作

建议按以下顺序继续完善：

1. 清理过时文档，统一与当前代码状态保持一致
2. 评估将 `CLOB_WS_URL` 改为可选配置
3. 评估余额读取是否切换为 Polymarket balance/allowance 接口
4. 为 MongoDB 集合增加必要索引与执行审计字段
5. 为主流程补充自动化测试与回归测试用例
