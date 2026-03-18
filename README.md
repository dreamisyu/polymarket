# Polymarket Copy Trading Bot

A **production-grade, real-time copy trading system** for **Polymarket**, designed to automatically mirror trades from selected wallets with high reliability, low latency, and robust risk controls. Built in **TypeScript** with **Node.js**, the bot integrates directly with Polymarket's **Central Limit Order Book (CLOB)** API for institutional-level execution.

---

## 💝 Support the Project

If you find this bot helpful and profitable, we'd greatly appreciate your support! Consider sending 10% of your profits to help maintain and improve this project:

**Wallet Address:** `4GNqE1cn7wRZyGsv8MHHMf8C6QSc3Mk3fWYkLdTNf7EX`

Your support helps us continue developing and maintaining this tool. Thank you! 🙏

---

## Overview

The Polymarket Copy Trading Bot continuously monitors target wallets and replicates their trading activity according to configurable risk parameters. It is designed for **professional deployment**, supporting automated trade execution, precise order handling, and comprehensive logging.

### Core Capabilities

- **Real-Time Trade Monitoring** – Continuously fetches and processes trades from target wallets
- **Automatic Trade Execution** – Mirrors buy/sell/merge operations with intelligent position matching
- **Advanced Risk Management** – Balance-based position sizing and retry mechanisms
- **Flexible Order Execution** – Supports FOK (Fill-or-Kill) order types
- **MongoDB Integration** – Persistent tracking of trades and positions
- **Multi-Outcome Compatibility** – Works seamlessly with binary and multi-outcome markets

---

> ⚠️ **Past performance does not guarantee future results.** Trading prediction markets involves significant risk. Use responsibly and only with capital you can afford to lose.

---

## 📊 Trading History & Performance

#### target address : https://polymarket.com/@k9Q2mX4L8A7ZP3R

The bot has demonstrated profitable performance in testing. Below is a screenshot showing the profit/loss progression over a test period:

### Updated profit : 3 / 11 / 2026

<img width="508" height="244" alt="image" src="https://github.com/user-attachments/assets/76fbdbe7-e205-4066-bb94-1a3f9ed75309" />

![Trading History - Profit/Loss Progression](./test/one.jpg)]

**Test Results Summary:**

- **Initial Profit:** $28.08 (Dec 20, 2025 6:00 PM)
- **Final Profit:** $923.41 (Dec 22, 2025 6:00 AM)
- **Time Period:** ~36 hours
- **Performance:** Consistent upward trend with significant profit accumulation
- **Growth:** Over 3,200% increase in profit during the test period

---

<img width="651" height="830" alt="image" src="https://github.com/user-attachments/assets/79eafc8f-6133-4eed-a275-2d692774b056" />
<img width="651" height="830" alt="image" src="https://github.com/user-attachments/assets/e79fac4f-9aa2-407d-97fe-49a673edac11" />
<img width="900" height="808" alt="image" src="https://github.com/user-attachments/assets/ff115671-3621-4cd1-9684-be13c3b11ffe" />

_Note: These results are from a test environment. Real-world performance may vary based on market conditions, wallet selection, and configuration parameters._

---

## System Architecture

### Technology Stack

- **Runtime**: Node.js 20.10+（推荐 24.x，开发脚本按 `tsx` 方式运行）
- **Language**: TypeScript (v5.7+)
- **Blockchain**: Polygon (Ethereum-compatible L2)
- **Web3**: Ethers.js v6
- **Database**: MongoDB
- **APIs**:
    - `@polymarket/clob-client` - Polymarket CLOB trading client
    - Polymarket Data API - For fetching activities and positions
- **Utilities**: Axios, Mongoose, Ora (spinners)

### High-Level Flow

```
Polymarket Data API (HTTP Polling)
        ↓
Trade Monitor (Fetches & Validates Trades)
        ↓
MongoDB (Stores Trade History)
        ↓
Trade Executor (Reads Pending Trades)
        ↓
Position Analysis (Compares Wallets)
        ↓
CLOB Client (Executes Orders)
        ↓
Order Execution (Buy/Sell/Merge Strategies)
```

---

## Installation

### Prerequisites

- **Node.js** 20.10 到 24.x 以及 **npm** 10+
- **MongoDB** (running locally or remote)
- **Polygon Wallet** funded with USDC
- **Polymarket Account** with API access

### Setup Steps

1. **Clone the repository:**

```bash
git clone https://github.com/BlackSkyorg/polymarket-copytrading-bot.git
cd Polymarket-copy-trading-bot-2025-12
```

2. **Install dependencies:**

```bash
npm install
```

3. **Create environment configuration:**

建议直接复制 `.env-example` 为 `.env`，再按你的钱包和运行模式修改。下面是最小可运行示例：

```env
# 建议先用 trace 做本地模拟验证
EXECUTION_MODE=trace
TRACE_ID=default
TRACE_INITIAL_BALANCE=1000

# Target user wallet address to copy trades from
USER_ADDRESS=0xYourTargetWalletAddress

# Your wallet address (proxy wallet) that will execute trades
PROXY_WALLET=0xYourProxyWalletAddress

# Private key of your proxy wallet (64 hex characters, NO 0x prefix)
PRIVATE_KEY=your_private_key_here

# Polymarket CLOB API URLs
CLOB_HTTP_URL=https://clob.polymarket.com
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
USER_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user

# MongoDB connection string
MONGO_URI=mongodb://localhost:27017/polymarket_copytrading

# Polygon RPC URL (for checking balances)
RPC_URL=https://polygon.drpc.org

# USDC contract address on Polygon
USDC_CONTRACT_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

# Optional: Configuration defaults
FETCH_INTERVAL=1
TOO_OLD_TIMESTAMP=24
RETRY_LIMIT=3
MAX_SLIPPAGE_BPS=300
MAX_ORDER_USDC=0
MARKET_WS_ENABLED=true
```

完整配置项请以 [`.env-example`](./.env-example) 为准。

4. **Start MongoDB:**

```bash
# Windows
net start MongoDB

# Linux/Mac
sudo systemctl start mongod
# or
mongod
```

5. **Start the bot:**

```bash
# Development mode (with tsx)
npm run dev

# Type check
npm run typecheck

# Basic validation
npm run validate:basic

# Or build and run
npm run build
npm start
```

On first launch, API credentials are automatically created/derived from your wallet.

---

## ⚙️ Configuration Reference

| Variable                | Description                               | Required      |
| ----------------------- | ----------------------------------------- | ------------- |
| `EXECUTION_MODE`        | `trace` 为本地模拟，`live` 为真实下单     | No            |
| `TRACE_ID`              | 模拟执行标识，决定 trace 集合名与报表标签 | No            |
| `TRACE_INITIAL_BALANCE` | 模拟模式初始资金（USDC）                  | No            |
| `USER_ADDRESS`          | 被跟单的钱包地址                          | Yes           |
| `PROXY_WALLET`          | 你的执行钱包地址                          | Live 模式必填 |
| `PRIVATE_KEY`           | 执行钱包私钥，64 位十六进制且不带 `0x`    | Live 模式必填 |
| `CLOB_HTTP_URL`         | Polymarket CLOB HTTP 接口                 | Live 模式必填 |
| `CLOB_WS_URL`           | 市场数据 WebSocket                        | Live 模式必填 |
| `USER_WS_URL`           | 用户订单状态 WebSocket                    | No            |
| `MONGO_URI`             | MongoDB 连接串                            | Yes           |
| `RPC_URL`               | Polygon RPC                               | Live 模式必填 |
| `USDC_CONTRACT_ADDRESS` | Polygon 上的 USDC 合约地址                | Live 模式必填 |
| `FETCH_INTERVAL`        | 监控轮询间隔（秒）                        | No            |
| `TOO_OLD_TIMESTAMP`     | 冷启动时忽略多少小时前的活动              | No            |
| `RETRY_LIMIT`           | 执行失败后的最大重试次数                  | No            |
| `MAX_SLIPPAGE_BPS`      | 最大允许滑点，单位 bps                    | No            |
| `MAX_ORDER_USDC`        | 单笔最大下单金额，`0` 表示不限制          | No            |
| `MARKET_WS_ENABLED`     | 是否启用市场 WebSocket 缓存               | No            |

更多配置项和默认值请直接查看 [`.env-example`](./.env-example) 与 [`src/config/env.ts`](./src/config/env.ts)。

---

## Usage

### Start Copy Trading

```bash
npm run dev
```

The bot will:

1. Connect to MongoDB
2. Initialize CLOB client and create/derive API keys
3. Start trade monitor (fetches trades every X seconds)
4. Start trade executor (processes pending trades)
5. Monitor target wallet and execute copy trades automatically

### Expected Output

When running successfully, you should see:

```
MongoDB connected
Target User Wallet address is: 0x...
My Wallet address is: 0x...
API Key created/derived
Trade Monitor is running every 1 seconds
Executing Copy Trading
Waiting for new transactions...
```

### Trade Execution Flow

1. **Monitor**: Fetches user activities from Polymarket API
2. **Filter**: Identifies new TRADE type activities
3. **Store**: Saves new trades to MongoDB
4. **Execute**: Reads pending trades and determines action (buy/sell/merge)
5. **Match**: Compares positions between target wallet and your wallet
6. **Trade**: Executes orders via CLOB client
7. **Update**: Marks trades as processed in database

---

## Execution Logic

### Trade Lifecycle

1. **Fetch Activities**: Monitor target wallet via Polymarket Data API
2. **Filter Trades**: Identify TRADE type activities only
3. **Check Duplicates**: Verify trade hasn't been processed before
4. **Validate Timestamp**: Ignore trades older than configured threshold
5. **Save to Database**: Store new trades in MongoDB
6. **Read Pending Trades**: Query database for unprocessed trades
7. **Fetch Positions**: Get current positions for both wallets
8. **Get Balances**: Check USDC balances for both wallets
9. **Determine Condition**: Decide on buy/sell/merge based on positions
10. **Execute Order**: Place order via CLOB client using appropriate strategy
11. **Update Status**: Mark trade as processed in database

### Trading Strategies

- **Buy Strategy**: When target wallet buys, calculate position size based on balance ratio
- **Sell Strategy**: When target wallet sells, match the sell proportionally
- **Merge Strategy**: When target wallet closes position but you still hold, sell your position
- **Error Handling**: Retry failed orders up to RETRY_LIMIT, then mark as failed

---

## Project Structure

```
src/
 ├── index.ts                 # Main entry point
 ├── config/
 │   ├── db.ts                # MongoDB connection
 │   └── env.ts               # Environment variables
 ├── services/
 │   ├── tradeMonitor.ts      # Monitors target wallet trades
 │   ├── tradeExecutor.ts     # Executes copy trades
 │   └── createClobClient.ts # Alternative CLOB client (unused)
 ├── utils/
 │   ├── createClobClient.ts  # CLOB client initialization
 │   ├── fetchData.ts         # HTTP data fetching
 │   ├── getMyBalance.ts      # USDC balance checker
 │   ├── postOrder.ts         # Order execution logic
 │   └── spinner.ts           # Terminal spinner
 ├── models/
 │   └── userHistory.ts       # MongoDB schemas
 ├── interfaces/
 │   └── User.ts              # TypeScript interfaces
 └── test/
     └── test.ts              # Test utilities
```

---

## Logging & Monitoring

- Trade detection and execution
- Balance and allowance checks
- Redemption outcomes
- Structured logs for debugging and audits

Log levels: `info`, `success`, `warning`, `error`

---

## Risk Disclosure

- Copy trading amplifies both profits and losses
- Liquidity and slippage risks apply
- Gas fees incurred on every transaction
- WebSocket or API outages may impact execution

**Best Practices**:

- Start with low multipliers
- Enforce strict max order sizes
- Monitor balances regularly
- Test using dry-run modes

---

## 🛠️ Development

```bash
# Type check
npm run typecheck

# Run in development mode
npm run dev

# Basic validation
npm run validate:basic

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

---

## Strategy Development Story

This copy trading bot was developed as part of a comprehensive Polymarket trading strategy system. Development began in **December 2025**, focusing on automated trade execution and position management.

### Key Features

- Real-time trade monitoring and execution
- Intelligent position matching and sizing
- Automatic retry mechanisms for failed orders
- MongoDB-based trade history tracking
- Support for multiple market types

---

## Contact & Support

For deployment support, custom integrations, or professional inquiries:

- **Telegram**: [@blacksky](https://t.me/blacksky_jose)

---

## Troubleshooting

### Common Issues

1. **"USER_ADDRESS is not defined"**
    - Check your `.env` file exists and has all required variables

2. **"MongoDB connection error"**
    - Ensure MongoDB is running
    - Verify `MONGO_URI` is correct

3. **"Cannot find module '@polymarket/clob-client'"**
    - Run `npm install` to install dependencies

4. **"invalid hexlify value"**
    - Check `PRIVATE_KEY` is 64 hex characters without `0x` prefix

5. **"API Key creation failed"**
    - Verify `PRIVATE_KEY` matches `PROXY_WALLET`
    - Ensure wallet has proper permissions

### Testing

Before running in production:

1. Monitor first few trades carefully
2. Verify MongoDB is storing trades correctly
3. Check order execution logs

---

## License

ISC

---

**Disclaimer**: This software is provided as-is without warranties. Trading prediction markets involves substantial risk. Use responsibly and only with capital you can afford to lose. Past performance does not guarantee future results.
