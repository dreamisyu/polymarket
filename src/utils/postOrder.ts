import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;

export type PostOrderStatus = 'COMPLETED' | 'SKIPPED' | 'RETRYABLE_ERROR' | 'FAILED';

export interface PostOrderResult {
    status: PostOrderStatus;
    reason: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildResult = (status: PostOrderStatus, reason = ''): PostOrderResult => ({
    status,
    reason,
});

const buildFailureResult = (reason: string, executedChunks: number): PostOrderResult =>
    buildResult(executedChunks > 0 ? 'FAILED' : 'RETRYABLE_ERROR', reason);

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    myPosition: Pick<UserPositionInterface, 'asset' | 'size'> | undefined,
    sourcePositionAfterTrade: { size?: number } | undefined,
    trade: UserActivityInterface,
    myBalance: number,
    sourceBalanceAfterTrade: number
): Promise<PostOrderResult> => {
    if (condition === 'merge') {
        console.log('执行 merge 策略...');
        if (!myPosition) {
            return buildResult('SKIPPED', '本地无可 merge 的持仓');
        }

        let remaining = myPosition.size;
        let retry = 0;
        let executedChunks = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('获取 merge 盘口失败:', error);
                return buildFailureResult('获取盘口失败', executedChunks);
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('盘口暂无买单');
                return buildFailureResult('盘口暂无买单', executedChunks);
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const orderArgs =
                remaining <= parseFloat(maxPriceBid.size)
                    ? {
                          side: Side.SELL,
                          tokenID: myPosition.asset,
                          amount: remaining,
                          price: parseFloat(maxPriceBid.price),
                      }
                    : {
                          side: Side.SELL,
                          tokenID: myPosition.asset,
                          amount: parseFloat(maxPriceBid.size),
                          price: parseFloat(maxPriceBid.price),
                      };

            console.log('下单参数:', orderArgs);
            if (orderArgs.amount <= 0) {
                return buildFailureResult('订单数量无效', executedChunks);
            }

            try {
                const signedOrder = await clobClient.createMarketOrder(orderArgs);
                const response = await clobClient.postOrder(signedOrder, OrderType.FOK);

                if (response.success === true) {
                    retry = 0;
                    executedChunks += 1;
                    remaining -= orderArgs.amount;
                    console.log('下单成功:', response);
                    await sleep(500);
                    continue;
                }

                retry += 1;
                console.log(`下单失败，准备重试... (${retry}/${RETRY_LIMIT})`, response);
                await sleep(2000);
            } catch (error) {
                retry += 1;
                console.error(`merge 下单异常，准备重试... (${retry}/${RETRY_LIMIT})`, error);
                await sleep(2000);
            }
        }

        return remaining <= 0
            ? buildResult('COMPLETED')
            : buildFailureResult('merge 未能全部成交', executedChunks);
    }

    if (condition === 'buy') {
        console.log('执行买入策略...');

        const denominator = sourceBalanceAfterTrade + trade.usdcSize;
        if (denominator <= 0) {
            return buildResult('SKIPPED', '源账户余额快照无效，无法计算跟单比例');
        }

        if (myBalance <= 0) {
            return buildResult('SKIPPED', '本地可用余额不足');
        }

        const ratio = myBalance / denominator;
        let remaining = Math.min(trade.usdcSize * ratio, myBalance);
        let retry = 0;
        let executedChunks = 0;

        console.log('跟单比例:', ratio);

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('获取买盘口失败:', error);
                return buildFailureResult('获取盘口失败', executedChunks);
            }

            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('盘口暂无卖单');
                return buildFailureResult('盘口暂无卖单', executedChunks);
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            const askPrice = parseFloat(minPriceAsk.price);
            if (askPrice - 0.05 > trade.price) {
                return buildResult('SKIPPED', '当前买一价格偏离源成交价过大');
            }

            const orderArgs =
                remaining <= parseFloat(minPriceAsk.size) * askPrice
                    ? {
                          side: Side.BUY,
                          tokenID: trade.asset,
                          amount: remaining,
                          price: askPrice,
                      }
                    : {
                          side: Side.BUY,
                          tokenID: trade.asset,
                          amount: parseFloat(minPriceAsk.size) * askPrice,
                          price: askPrice,
                      };

            console.log('下单参数:', orderArgs);
            if (orderArgs.amount <= 0) {
                return buildFailureResult('订单金额无效', executedChunks);
            }

            try {
                const signedOrder = await clobClient.createMarketOrder(orderArgs);
                const response = await clobClient.postOrder(signedOrder, OrderType.FOK);

                if (response.success === true) {
                    retry = 0;
                    executedChunks += 1;
                    remaining -= orderArgs.amount;
                    console.log('下单成功:', response);
                    await sleep(500);
                    continue;
                }

                retry += 1;
                console.log(`下单失败，准备重试... (${retry}/${RETRY_LIMIT})`, response);
                await sleep(2000);
            } catch (error) {
                retry += 1;
                console.error(`买单异常，准备重试... (${retry}/${RETRY_LIMIT})`, error);
                await sleep(2000);
            }
        }

        return remaining <= 0
            ? buildResult('COMPLETED')
            : buildFailureResult('买单未能全部成交', executedChunks);
    }

    if (condition === 'sell') {
        console.log('执行卖出策略...');
        if (!myPosition) {
            return buildResult('SKIPPED', '本地没有可卖出的仓位');
        }

        let remaining = 0;
        if (!sourcePositionAfterTrade) {
            return buildResult('RETRYABLE_ERROR', '缺少源账户持仓快照');
        }

        const denominator = (sourcePositionAfterTrade.size || 0) + trade.size;
        remaining = denominator > 0 ? myPosition.size * (trade.size / denominator) : 0;

        let retry = 0;
        let executedChunks = 0;

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('获取卖盘口失败:', error);
                return buildFailureResult('获取盘口失败', executedChunks);
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('盘口暂无买单');
                return buildFailureResult('盘口暂无买单', executedChunks);
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const bidPrice = parseFloat(maxPriceBid.price);
            if (trade.price && bidPrice + 0.05 < trade.price) {
                return buildResult('SKIPPED', '当前卖一价格偏离源成交价过大');
            }

            const orderArgs =
                remaining <= parseFloat(maxPriceBid.size)
                    ? {
                          side: Side.SELL,
                          tokenID: trade.asset,
                          amount: remaining,
                          price: bidPrice,
                      }
                    : {
                          side: Side.SELL,
                          tokenID: trade.asset,
                          amount: parseFloat(maxPriceBid.size),
                          price: bidPrice,
                      };

            console.log('下单参数:', orderArgs);
            if (orderArgs.amount <= 0) {
                return buildFailureResult('订单数量无效', executedChunks);
            }

            try {
                const signedOrder = await clobClient.createMarketOrder(orderArgs);
                const response = await clobClient.postOrder(signedOrder, OrderType.FOK);

                if (response.success === true) {
                    retry = 0;
                    executedChunks += 1;
                    remaining -= orderArgs.amount;
                    console.log('下单成功:', response);
                    await sleep(500);
                    continue;
                }

                retry += 1;
                console.log(`下单失败，准备重试... (${retry}/${RETRY_LIMIT})`, response);
                await sleep(2000);
            } catch (error) {
                retry += 1;
                console.error(`卖单异常，准备重试... (${retry}/${RETRY_LIMIT})`, error);
                await sleep(2000);
            }
        }

        return remaining <= 0
            ? buildResult('COMPLETED')
            : buildFailureResult('卖单未能全部成交', executedChunks);
    }

    return buildResult('SKIPPED', `暂不支持的执行条件: ${condition}`);
};

export default postOrder;
