// target-wallet-strategy-analyzer.mjs
//
// 完全适配当前 lib 文件导出的 Polymarket bot 分析脚本。
//
// 依赖的导出（与你现有 lib 对齐）：
// - ./lib/runtime.mjs
//   buildTimeRange, quantile, formatUsd, formatPct, toSafeNumber
// - ./lib/polymarketApi.mjs
//   fetchPolymarketActivities, fetchPolymarketPositions
//
// 用途：
// 1) 价格感知的活动画像
// 2) condition/outcome 级 episode 建仓分析
// 3) 小资金阈值穿越分析（例如 1u / 2u / 5u 何时能凑够，并且那时已经追价多少）
// 4) 双边 overlay / merge 代理分析
// 5) 给出更适合优化跟单逻辑的策略提示
//
// 用法示例：
// node scripts/target-wallet-strategy-analyzer.mjs \
//   --user-address 0x297fbd45782af37d899015aebbc52437f3d55103 \
//   --hours 6
//
// node scripts/target-wallet-strategy-analyzer.mjs \
//   --user-address 0x297fbd45782af37d899015aebbc52437f3d55103 \
//   --hours 6 \
//   --scope crypto-5m
//
// node scripts/target-wallet-strategy-analyzer.mjs \
//   --user-address 0x297fbd45782af37d899015aebbc52437f3d55103 \
//   --hours 6 \
//   --episode-gap-ms 5000 \
//   --thresholds-usdc 1,2,5,10,20 \
//   --json

import {
    buildTimeRange,
    quantile,
    formatUsd,
    formatPct,
    toSafeNumber,
} from './lib/runtime.mjs';

import {
    fetchPolymarketActivities,
    fetchPolymarketPositions,
} from './lib/polymarketApi.mjs';

const DEFAULTS = {
    hours: 6,
    episodeGapMs: 5000,
    overlayGapMs: 30000,
    thresholdsUsdc: [1, 2, 5, 10, 20],
    topN: 12,
    scope: 'all',
    json: false,
};

function parseArgs(argv) {
    const out = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        const next = argv[i + 1];
        if (a === '--user-address') out.userAddress = next, i += 1;
        else if (a === '--hours') out.hours = Number(next), i += 1;
        else if (a === '--from') out.from = next, i += 1;
        else if (a === '--to') out.to = next, i += 1;
        else if (a === '--episode-gap-ms') out.episodeGapMs = Number(next), i += 1;
        else if (a === '--overlay-gap-ms') out.overlayGapMs = Number(next), i += 1;
        else if (a === '--thresholds-usdc') out.thresholdsUsdc = String(next).split(',').map(Number).filter(Number.isFinite), i += 1;
        else if (a === '--scope') out.scope = next, i += 1;
        else if (a === '--top-n') out.topN = Number(next), i += 1;
        else if (a === '--json') out.json = true;
    }
    if (!String(out.userAddress || '').trim()) {
        throw new Error('Missing --user-address');
    }
    return out;
}

function nowIso() {
    return new Date().toISOString();
}

function hoursAgoIso(hours) {
    return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function fmtNum(n, digits = 6) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 'NA';
    return v.toFixed(digits);
}

function fmtBps(n, digits = 1) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 'NA';
    return `${v.toFixed(digits)} bps`;
}

function fmtPctRatio(ratio, digits = 2) {
    const v = Number(ratio);
    if (!Number.isFinite(v)) return 'NA';
    return formatPct(v * 100, digits);
}

function normalizeStr(x) {
    return String(x ?? '').trim();
}

function lower(x) {
    return normalizeStr(x).toLowerCase();
}

function tsMillis(x) {
    const t = new Date(x).getTime();
    return Number.isFinite(t) ? t : NaN;
}

function safeDiv(a, b, d = 0) {
    return b ? a / b : d;
}

function isCrypto5m(title = '') {
    const t = lower(title);
    return (t.includes('bitcoin up or down') || t.includes('ethereum up or down')) &&
        (t.includes('5') || t.includes('10') || t.includes('15') || t.includes('20') || t.includes('25') || t.includes('30') || t.includes('35') || t.includes('40') || t.includes('45') || t.includes('50') || t.includes('55'));
}

function scopeFilter(scope, row) {
    if (scope === 'all') return true;
    const title = row.marketTitle || row.conditionTitle || '';
    if (scope === 'crypto-5m') return isCrypto5m(title);
    if (scope === 'btc') return lower(title).includes('bitcoin');
    if (scope === 'eth') return lower(title).includes('ethereum');
    return true;
}

function inferAction(raw) {
    const act = lower(raw.type || raw.activityType || raw.actType);
    const side = lower(raw.side);

    if (act.includes('redeem')) return 'REDEEM';
    if (act.includes('merge')) return 'MERGE';
    if (act.includes('sell') || side === 'sell') return 'SELL';
    if (act.includes('buy') || act.includes('trade') || side === 'buy') return 'BUY';
    return 'OTHER';
}

function guessOutcomeSide(raw) {
    const candidates = [
        raw.outcome,
        raw.outcomeName,
        raw.outcome_name,
        raw.sideName,
        raw.tokenName,
        raw.asset,
        raw.title,
    ].map(normalizeStr).filter(Boolean);
    return candidates[0] || 'UNKNOWN';
}

function normalizeActivity(raw) {
    const rawTs = toSafeNumber(raw.timestamp, 0);
    const ts = rawTs > 0
        ? (rawTs > 1_000_000_000_000 ? rawTs : rawTs * 1000)
        : tsMillis(raw.createdAt || raw.time || raw.ts);

    const usdc = toSafeNumber(
        raw.usdc ?? raw.usdcSize ?? raw.amount ?? raw.usdcAmount ?? raw.sizeUsd,
        0
    );

    const shares = toSafeNumber(
        raw.size ?? raw.shares ?? raw.outcomeShares ?? raw.assetSize,
        0
    );

    let price = toSafeNumber(raw.price ?? raw.avgPrice ?? raw.executionPrice, NaN);
    if (!Number.isFinite(price) || price <= 0) {
        if (usdc > 0 && shares > 0) {
            price = usdc / shares;
        }
    }
    if (!Number.isFinite(price) || price <= 0) price = NaN;

    return {
        raw,
        ts,
        iso: Number.isFinite(ts) ? new Date(ts).toISOString() : '',
        activityType: inferAction(raw),
        usdc,
        shares,
        price,
        priceValid: Number.isFinite(price) && price > 0,
        conditionId: normalizeStr(raw.conditionId || raw.condition || raw.marketConditionId || raw.condition_id),
        marketId: normalizeStr(raw.marketId || raw.market || raw.clobTokenId || raw.tokenId || raw.market_id),
        slug: normalizeStr(raw.slug || raw.marketSlug),
        marketTitle: normalizeStr(raw.marketTitle || raw.title || raw.question || raw.marketQuestion),
        conditionTitle: normalizeStr(raw.conditionTitle || raw.marketTitle || raw.title || raw.question || raw.marketQuestion),
        outcome: normalizeStr(raw.outcome || raw.outcomeName || raw.outcome_name),
        side: guessOutcomeSide(raw),
        txHash: normalizeStr(raw.transactionHash || raw.txHash || raw.hash),
        activityKey: normalizeStr(raw.activityKey || raw.id || raw.transactionHash),
    };
}

function priceStats(rows) {
    const valid = rows.filter(r => r.priceValid);
    if (!valid.length) {
        return {
            first: NaN,
            last: NaN,
            min: NaN,
            max: NaN,
            vwap: NaN,
            driftBps: NaN,
            rangeBps: NaN,
            chasingScore: NaN,
            dipBuyScore: NaN,
        };
    }

    const first = valid[0].price;
    const last = valid[valid.length - 1].price;
    const prices = valid.map(r => r.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const vwapNum = valid.reduce((s, r) => s + r.price * Math.max(r.shares, 0), 0);
    const vwapDen = valid.reduce((s, r) => s + Math.max(r.shares, 0), 0);
    const vwap = safeDiv(vwapNum, vwapDen, NaN);
    const driftBps = Number.isFinite(first) && first > 0 ? ((last - first) / first) * 10000 : NaN;
    const rangeBps = Number.isFinite(min) && min > 0 ? ((max - min) / min) * 10000 : NaN;

    let upwardWeighted = 0;
    let downwardWeighted = 0;
    for (let i = 1; i < valid.length; i += 1) {
        const dp = valid[i].price - valid[i - 1].price;
        const w = Math.max(valid[i].usdc, 0);
        if (dp > 0) upwardWeighted += dp * w;
        if (dp < 0) downwardWeighted += (-dp) * w;
    }

    const chasingScore = safeDiv(upwardWeighted, upwardWeighted + downwardWeighted, NaN);
    const dipBuyScore = safeDiv(downwardWeighted, upwardWeighted + downwardWeighted, NaN);

    return { first, last, min, max, vwap, driftBps, rangeBps, chasingScore, dipBuyScore };
}

function groupBy(items, keyFn) {
    const m = new Map();
    for (const item of items) {
        const k = keyFn(item);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(item);
    }
    return m;
}

function finalizeEpisode(rows) {
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalUsdc = sorted.reduce((s, r) => s + r.usdc, 0);
    const totalShares = sorted.reduce((s, r) => s + r.shares, 0);
    const ps = priceStats(sorted);

    return {
        conditionId: first.conditionId,
        marketTitle: first.marketTitle || first.conditionTitle,
        conditionTitle: first.conditionTitle || first.marketTitle,
        outcome: first.outcome,
        side: first.side,
        startTs: first.ts,
        endTs: last.ts,
        startIso: first.iso,
        endIso: last.iso,
        durationMs: last.ts - first.ts,
        tradeCount: sorted.length,
        totalUsdc,
        totalShares,
        ...ps,
        rows: sorted,
    };
}

function buildEpisodes(buys, gapMs) {
    const groups = groupBy(buys, r => `${r.conditionId}__${r.side}`);
    const episodes = [];

    for (const rows of groups.values()) {
        rows.sort((a, b) => a.ts - b.ts);
        let current = null;

        for (const row of rows) {
            if (!current) {
                current = [row];
                continue;
            }

            const prev = current[current.length - 1];
            if ((row.ts - prev.ts) <= gapMs) {
                current.push(row);
            } else {
                episodes.push(finalizeEpisode(current));
                current = [row];
            }
        }

        if (current && current.length) {
            episodes.push(finalizeEpisode(current));
        }
    }

    episodes.sort((a, b) => a.startTs - b.startTs);
    return episodes;
}

function thresholdCrossAnalysis(episodes, thresholdsUsdc) {
    const hits = [];

    for (const ep of episodes) {
        for (const threshold of thresholdsUsdc) {
            let cumUsdc = 0;
            let firstPrice = NaN;
            let crossed = null;

            for (const row of ep.rows) {
                cumUsdc += row.usdc;
                if (!Number.isFinite(firstPrice) && row.priceValid) firstPrice = row.price;
                if (cumUsdc >= threshold) {
                    crossed = row;
                    break;
                }
            }

            if (!crossed) continue;

            const crossPrice = crossed.priceValid ? crossed.price : NaN;
            const driftBps = (Number.isFinite(firstPrice) && Number.isFinite(crossPrice) && firstPrice > 0)
                ? ((crossPrice - firstPrice) / firstPrice) * 10000
                : NaN;

            hits.push({
                threshold,
                conditionId: ep.conditionId,
                marketTitle: ep.marketTitle,
                side: ep.side,
                startTs: ep.startTs,
                crossTs: crossed.ts,
                delayMs: crossed.ts - ep.startTs,
                tradeIndex: ep.rows.indexOf(crossed) + 1,
                cumUsdc,
                firstPrice,
                crossPrice,
                driftBps,
            });
        }
    }

    return hits;
}

function buildOverlayByCondition(buys, overlayGapMs) {
    const byCondition = groupBy(buys, r => r.conditionId);
    const out = [];

    for (const [conditionId, rows] of byCondition.entries()) {
        const bySide = groupBy(rows, r => r.side);
        const sides = [...bySide.keys()].filter(Boolean);
        if (sides.length < 2) continue;

        const sideAgg = sides.map(side => {
            const rs = [...bySide.get(side)].sort((a, b) => a.ts - b.ts);
            const usdc = rs.reduce((s, r) => s + r.usdc, 0);
            const shares = rs.reduce((s, r) => s + r.shares, 0);
            const vwap = shares > 0 ? usdc / shares : NaN;
            return {
                side,
                rows: rs,
                count: rs.length,
                usdc,
                shares,
                vwap,
                firstTs: rs[0].ts,
                lastTs: rs[rs.length - 1].ts,
            };
        }).sort((a, b) => a.firstTs - b.firstTs);

        if (sideAgg.length < 2) continue;

        const leader = sideAgg[0];
        const follower = sideAgg[1];
        const lagMs = follower.firstTs - leader.firstTs;
        const overlap = Math.abs(lagMs) <= overlayGapMs;
        const bundleVwapCost = Number.isFinite(leader.vwap) && Number.isFinite(follower.vwap)
            ? leader.vwap + follower.vwap
            : NaN;
        const mergeGrossEdge = Number.isFinite(bundleVwapCost) ? 1 - bundleVwapCost : NaN;

        out.push({
            conditionId,
            marketTitle: sideAgg.find(Boolean)?.rows?.[0]?.marketTitle || '',
            leaderSide: leader.side,
            followerSide: follower.side,
            leaderCount: leader.count,
            followerCount: follower.count,
            leaderUsdc: leader.usdc,
            followerUsdc: follower.usdc,
            leaderVwap: leader.vwap,
            followerVwap: follower.vwap,
            lagMs,
            overlap,
            bundleVwapCost,
            mergeGrossEdge,
        });
    }

    out.sort((a, b) => toSafeNumber(b.mergeGrossEdge, -Infinity) - toSafeNumber(a.mergeGrossEdge, -Infinity));
    return out;
}

function summarizeActivity(rows) {
    const buys = rows.filter(r => r.activityType === 'BUY');
    const sells = rows.filter(r => r.activityType === 'SELL');
    const merges = rows.filter(r => r.activityType === 'MERGE');
    const redeems = rows.filter(r => r.activityType === 'REDEEM');

    const buyUsdc = buys.reduce((s, r) => s + r.usdc, 0);
    const small1 = buys.filter(r => r.usdc < 1).length;
    const small01 = buys.filter(r => r.usdc < 0.1).length;
    const usdcVals = buys.map(r => r.usdc).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const sortedBuys = [...buys].sort((a, b) => a.ts - b.ts);
    const gaps = [];
    for (let i = 1; i < sortedBuys.length; i += 1) {
        gaps.push((sortedBuys[i].ts - sortedBuys[i - 1].ts) / 1000);
    }

    return {
        activityCount: rows.length,
        buyCount: buys.length,
        sellCount: sells.length,
        mergeCount: merges.length,
        redeemCount: redeems.length,
        buyUsdc,
        buyLt1Ratio: safeDiv(small1, buys.length, 0),
        buyLt01Ratio: safeDiv(small01, buys.length, 0),
        buyUsdcP25: quantile(usdcVals, 0.25),
        buyUsdcP50: quantile(usdcVals, 0.50),
        buyUsdcP75: quantile(usdcVals, 0.75),
        buyUsdcP90: quantile(usdcVals, 0.90),
        gapP50: quantile(gaps, 0.50),
        gapP75: quantile(gaps, 0.75),
        gapP90: quantile(gaps, 0.90),
    };
}

function inferPositionSummary(positions) {
    if (!Array.isArray(positions) || positions.length === 0) {
        return {
            openCount: 0,
            totalCurrentValue: 0,
            topPositions: [],
        };
    }

    const normalized = positions.map((position) => {
        const size = toSafeNumber(position.size, 0);
        const currentValue = toSafeNumber(
            position.currentValue ?? position.amount ?? position.cashPnl ?? position.usdcValue,
            0
        );
        const title = String(
            position.title || position.marketTitle || position.question || position.slug || 'UNKNOWN'
        ).trim();
        const outcome = String(position.outcome || position.outcomeName || '').trim();
        return {
            title,
            outcome,
            size,
            currentValue,
        };
    });

    const openPositions = normalized.filter(p => p.size > 0 || p.currentValue > 0);
    const topPositions = [...openPositions]
        .sort((a, b) => b.currentValue - a.currentValue)
        .slice(0, 10);

    return {
        openCount: openPositions.length,
        totalCurrentValue: openPositions.reduce((sum, p) => sum + p.currentValue, 0),
        topPositions,
    };
}

function strategyHints({ summary, episodes, thresholdHits, overlays }) {
    const hints = [];
    const buyOnly = summary.buyCount > 0 && summary.sellCount === 0;
    const ultraHighFreq = summary.gapP50 <= 1 && summary.buyCount >= 1000;
    const tinyMedian = summary.buyUsdcP50 <= 3;
    const highChasingEpisodes = episodes.filter(e => Number.isFinite(e.chasingScore) && e.chasingScore >= 0.7).length;
    const posMergeEdge = overlays.filter(o => Number.isFinite(o.mergeGrossEdge) && o.mergeGrossEdge > 0).length;
    const threshold1 = thresholdHits.filter(h => h.threshold === 1);
    const threshold2 = thresholdHits.filter(h => h.threshold === 2);
    const med1Delay = quantile(threshold1.map(x => x.delayMs / 1000), 0.5);
    const med1Drift = quantile(threshold1.map(x => x.driftBps).filter(Number.isFinite), 0.5);
    const med2Delay = quantile(threshold2.map(x => x.delayMs / 1000), 0.5);
    const med2Drift = quantile(threshold2.map(x => x.driftBps).filter(Number.isFinite), 0.5);

    if (ultraHighFreq && tinyMedian) {
        hints.push('该账户是高频碎单型，逐笔等比例跟单大概率失真，优先改为 episode/事件触发式跟单。');
    }
    if (buyOnly) {
        hints.push('该账户样本期内几乎只 BUY 不 SELL，更像持续建仓/库存管理/到期赎回型账户；出场逻辑不要依赖它的卖出。');
    }
    if (Number.isFinite(med1Delay) && med1Delay > 10) {
        hints.push(`若你以 1u 为最小执行额，中位要等 ${fmtNum(med1Delay, 2)}s 才能凑到一次可执行，说明“累计到 1u 再跟”也会明显滞后。`);
    }
    if (Number.isFinite(med1Drift) && med1Drift > 50) {
        hints.push(`episode 从首笔到凑够 1u 时，中位已追价 ${fmtBps(med1Drift)}；建议加价格闸门，例如偏离首笔 VWAP > 50~100bps 就放弃。`);
    }
    if (Number.isFinite(med2Delay) && med2Delay > 0) {
        hints.push(`若首单固定做 2u，中位需等待 ${fmtNum(med2Delay, 2)}s 才满足；这比逐笔等比例更适合作为事件触发跟单阈值。`);
    }
    if (Number.isFinite(med2Drift) && med2Drift > 80) {
        hints.push(`如果你用 2u 首单，中位追价偏移约 ${fmtBps(med2Drift)}；固定 2u 首单适合，但必须配合价格偏移过滤。`);
    }
    if (highChasingEpisodes > episodes.length * 0.4 && episodes.length > 0) {
        hints.push('较多 episode 呈现 price-chasing 特征，说明 bot 会在价格上行中继续追买；你跟单时更应限制首单触发后的追高。');
    }
    if (posMergeEdge > 0) {
        hints.push(`发现 ${posMergeEdge} 个 condition 存在双边 bundle 成本低于 1 的正 edge 代理，说明该 bot 可能存在双边补边/merge 类行为，值得重点观察其补边延迟与双边 VWAP。`);
    }
    if (!hints.length) {
        hints.push('样本期没有明显单一模式，建议继续扩大观察窗口并结合盘口/成交簿数据。');
    }
    return hints;
}

function renderTopEpisodes(episodes, topN) {
    return episodes
        .slice()
        .sort((a, b) => b.totalUsdc - a.totalUsdc)
        .slice(0, topN)
        .map(ep => (
            `- ${ep.marketTitle} | ${ep.side}` +
            ` | trades=${ep.tradeCount}` +
            ` | usdc=${formatUsd(ep.totalUsdc)}` +
            ` | dur=${fmtNum(ep.durationMs / 1000, 2)}s` +
            ` | first=${fmtNum(ep.first, 6)}` +
            ` last=${fmtNum(ep.last, 6)}` +
            ` vwap=${fmtNum(ep.vwap, 6)}` +
            ` | drift=${fmtBps(ep.driftBps)}` +
            ` range=${fmtBps(ep.rangeBps)}` +
            ` | chasing=${fmtPctRatio(ep.chasingScore || 0)}`
        ));
}

function renderTopOverlays(overlays, topN) {
    return overlays.slice(0, topN).map(o => (
        `- ${o.marketTitle}` +
        ` | ${o.leaderSide} vs ${o.followerSide}` +
        ` | lag=${fmtNum(o.lagMs / 1000, 2)}s` +
        ` | leaderVWAP=${fmtNum(o.leaderVwap, 6)}` +
        ` followerVWAP=${fmtNum(o.followerVwap, 6)}` +
        ` | bundleCost=${fmtNum(o.bundleVwapCost, 6)}` +
        ` | grossEdge=${fmtPctRatio(o.mergeGrossEdge || 0, 4)}`
    ));
}

function renderThresholds(thresholdHits, threshold, topN) {
    return thresholdHits
        .filter(h => h.threshold === threshold)
        .sort((a, b) => toSafeNumber(b.driftBps, -Infinity) - toSafeNumber(a.driftBps, -Infinity))
        .slice(0, topN)
        .map(h => (
            `- ${h.marketTitle} | ${h.side}` +
            ` | delay=${fmtNum(h.delayMs / 1000, 2)}s` +
            ` | trade#=${h.tradeIndex}` +
            ` | first=${fmtNum(h.firstPrice, 6)}` +
            ` cross=${fmtNum(h.crossPrice, 6)}` +
            ` | drift=${fmtBps(h.driftBps)}`
        ));
}

function summarizeThresholdHits(thresholdHits, thresholdsUsdc) {
    return thresholdsUsdc.map((threshold) => {
        const subset = thresholdHits.filter(h => h.threshold === threshold);
        return {
            threshold,
            hitCount: subset.length,
            medianDelaySec: quantile(subset.map(x => x.delayMs / 1000), 0.5),
            p75DelaySec: quantile(subset.map(x => x.delayMs / 1000), 0.75),
            medianDriftBps: quantile(subset.map(x => x.driftBps).filter(Number.isFinite), 0.5),
            p75DriftBps: quantile(subset.map(x => x.driftBps).filter(Number.isFinite), 0.75),
            topExamples: subset
                .slice()
                .sort((a, b) => toSafeNumber(b.driftBps, -Infinity) - toSafeNumber(a.driftBps, -Infinity))
                .slice(0, 8)
                .map((h) => ({
                    marketTitle: h.marketTitle,
                    side: h.side,
                    delaySec: h.delayMs / 1000,
                    tradeIndex: h.tradeIndex,
                    firstPrice: h.firstPrice,
                    crossPrice: h.crossPrice,
                    driftBps: h.driftBps,
                })),
        };
    });
}

function buildLlmJson(result, topN) {
    const topEpisodes = result.episodes
        .slice()
        .sort((a, b) => b.totalUsdc - a.totalUsdc)
        .slice(0, topN)
        .map((ep) => ({
            marketTitle: ep.marketTitle,
            side: ep.side,
            tradeCount: ep.tradeCount,
            totalUsdc: ep.totalUsdc,
            durationSec: ep.durationMs / 1000,
            firstPrice: ep.first,
            lastPrice: ep.last,
            vwap: ep.vwap,
            driftBps: ep.driftBps,
            rangeBps: ep.rangeBps,
            chasingScore: ep.chasingScore,
            dipBuyScore: ep.dipBuyScore,
        }));

    const topOverlays = result.overlays
        .slice(0, topN)
        .map((o) => ({
            marketTitle: o.marketTitle,
            leaderSide: o.leaderSide,
            followerSide: o.followerSide,
            lagSec: o.lagMs / 1000,
            leaderCount: o.leaderCount,
            followerCount: o.followerCount,
            leaderUsdc: o.leaderUsdc,
            followerUsdc: o.followerUsdc,
            leaderVwap: o.leaderVwap,
            followerVwap: o.followerVwap,
            bundleVwapCost: o.bundleVwapCost,
            mergeGrossEdge: o.mergeGrossEdge,
            overlap: o.overlap,
        }));

    const episodeDurations = result.episodes.map(e => e.durationMs / 1000);
    const episodeUsdc = result.episodes.map(e => e.totalUsdc);
    const chasingScores = result.episodes.map(e => e.chasingScore).filter(Number.isFinite);

    return {
        meta: {
            userAddress: result.userAddress,
            from: result.from,
            to: result.to,
            params: result.params,
        },
        activitySummary: result.summary,
        positionSummary: result.positionSummary,
        episodeSummary: {
            episodeCount: result.episodeCount,
            medianEpisodeUsdc: quantile(episodeUsdc, 0.5),
            p75EpisodeUsdc: quantile(episodeUsdc, 0.75),
            medianEpisodeDurationSec: quantile(episodeDurations, 0.5),
            p75EpisodeDurationSec: quantile(episodeDurations, 0.75),
            medianChasingScore: quantile(chasingScores, 0.5),
            p75ChasingScore: quantile(chasingScores, 0.75),
        },
        topEpisodes,
        topOverlays,
        thresholdSummary: summarizeThresholdHits(result.thresholdHits, result.params.thresholdsUsdc),
        strategyHints: result.hints,
    };
}

async function main() {
    const args = parseArgs(process.argv);

    const fromIso = args.from || hoursAgoIso(args.hours);
    const toIso = args.to || nowIso();

    const range = buildTimeRange({
        hours: args.hours,
        sinceTs: args.from ? new Date(args.from).getTime() : 0,
        untilTs: args.to ? new Date(args.to).getTime() : 0,
    });

    const { activities, error: activityError } = await fetchPolymarketActivities(
        args.userAddress,
        {
            sinceTs: range.sinceTs,
            untilTs: range.untilTs,
            limit: 50000,
            sortDirection: 'ASC',
            userAgent: 'polymarket-copytrading-bot/analyzer',
        }
    );

    if (activityError) {
        throw new Error(activityError);
    }

    const rows = (Array.isArray(activities) ? activities : [])
        .map(normalizeActivity)
        .filter(r => Number.isFinite(r.ts))
        .filter(r => scopeFilter(args.scope, r))
        .sort((a, b) => a.ts - b.ts);

    const summary = summarizeActivity(rows);
    const buys = rows.filter(r => r.activityType === 'BUY');
    const episodes = buildEpisodes(buys, args.episodeGapMs);
    const thresholdHits = thresholdCrossAnalysis(episodes, args.thresholdsUsdc);
    const overlays = buildOverlayByCondition(buys, args.overlayGapMs);

    let positionSummary = null;
    const { positions, error: positionError } = await fetchPolymarketPositions(
        args.userAddress,
        'polymarket-copytrading-bot/analyzer'
    );
    if (!positionError && Array.isArray(positions)) {
        positionSummary = inferPositionSummary(positions);
    }

    const result = {
        userAddress: args.userAddress,
        from: fromIso,
        to: toIso,
        params: {
            episodeGapMs: args.episodeGapMs,
            overlayGapMs: args.overlayGapMs,
            thresholdsUsdc: args.thresholdsUsdc,
            scope: args.scope,
        },
        summary,
        positionSummary,
        episodeCount: episodes.length,
        episodes,
        thresholdHits,
        overlays,
        hints: strategyHints({ summary, episodes, thresholdHits, overlays }),
    };

    if (args.json) {
        console.log(JSON.stringify(buildLlmJson(result, args.topN), null, 2));
        return;
    }

    console.log('目标账户远程画像（价格感知增强版）');
    console.log(`- 账户: ${args.userAddress}`);
    console.log(`- 时间范围: ${fromIso} ~ ${toIso}`);
    console.log(`- scope: ${args.scope}`);
    console.log(`- episodeGapMs: ${args.episodeGapMs}`);
    console.log(`- overlayGapMs: ${args.overlayGapMs}`);
    console.log('');

    console.log('活动画像');
    console.log(`- 活动数: ${summary.activityCount}`);
    console.log(`- BUY / SELL / MERGE / REDEEM: ${summary.buyCount} / ${summary.sellCount} / ${summary.mergeCount} / ${summary.redeemCount}`);
    console.log(`- BUY 总额: ${formatUsd(summary.buyUsdc)}`);
    console.log(`- BUY 中 <1u 占比: ${fmtPctRatio(summary.buyLt1Ratio)}`);
    console.log(`- BUY 中 <0.1u 占比: ${fmtPctRatio(summary.buyLt01Ratio)}`);
    console.log(`- BUY usdc 分位: P25=${formatUsd(summary.buyUsdcP25)} P50=${formatUsd(summary.buyUsdcP50)} P75=${formatUsd(summary.buyUsdcP75)} P90=${formatUsd(summary.buyUsdcP90)}`);
    console.log(`- BUY 间隔: P50=${fmtNum(summary.gapP50, 2)}s P75=${fmtNum(summary.gapP75, 2)}s P90=${fmtNum(summary.gapP90, 2)}s`);
    if (positionSummary) {
        console.log(`- 当前持仓 openCount: ${positionSummary.openCount}`);
        console.log(`- 当前持仓 totalCurrentValue: ${formatUsd(positionSummary.totalCurrentValue)}`);
        if (positionSummary.topPositions.length) {
            console.log('- 当前持仓集中度:');
            for (const position of positionSummary.topPositions) {
                console.log(`  - ${position.title}${position.outcome ? ` | ${position.outcome}` : ''} | value=${formatUsd(position.currentValue)} | size=${fmtNum(position.size, 4)}`);
            }
        }
    }
    console.log('');

    console.log(`episode 分析（Top ${args.topN} by usdc）`);
    for (const line of renderTopEpisodes(episodes, args.topN)) console.log(line);
    console.log('');

    console.log(`双边 overlay / merge 代理（Top ${args.topN} by gross edge）`);
    const overlayLines = renderTopOverlays(overlays, args.topN);
    if (overlayLines.length) {
        for (const line of overlayLines) console.log(line);
    } else {
        console.log('- 无');
    }
    console.log('');

    for (const threshold of args.thresholdsUsdc) {
        console.log(`阈值穿越（价格感知跟单代理）- ${threshold}u`);
        const lines = renderThresholds(thresholdHits, threshold, args.topN);
        if (lines.length) {
            for (const line of lines) console.log(line);
        } else {
            console.log('- 无');
        }
        const subset = thresholdHits.filter(h => h.threshold === threshold);
        const medDelay = quantile(subset.map(x => x.delayMs / 1000), 0.5);
        const medDrift = quantile(subset.map(x => x.driftBps).filter(Number.isFinite), 0.5);
        console.log(`- 中位 delay=${fmtNum(medDelay, 2)}s | 中位 drift=${fmtBps(medDrift)}`);
        console.log('');
    }

    console.log('策略提示');
    for (const hint of result.hints) {
        console.log(`- ${hint}`);
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
});
