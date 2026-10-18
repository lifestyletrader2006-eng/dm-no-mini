import fs from 'node:fs';
import path from 'node:path';
import type {
  ExchangeConfig,
  FutureSetup,
  TradeRecord,
  ArbitrageSetup,
  BotErrorRecord,
  HistoricalForensicMove,
  SetupHistoryRecord,
} from '../../src/types/index.js';

export interface BotDatabaseData {
  config: ExchangeConfig;
  setups: FutureSetup[];
  trades: TradeRecord[];
  history: SetupHistoryRecord[];
  arbitrageSetups: ArbitrageSetup[];
  errors: BotErrorRecord[];
  forensics: HistoricalForensicMove[];
  commandLogs: Array<{ id: string; timestamp: string; command: string; output: string; status: 'SUCCESS' | 'ERROR' }>;
}

const DEFAULT_CONFIG: ExchangeConfig = {
  apiKey: process.env.DELTA_API_KEY || '',
  apiSecret: process.env.DELTA_API_SECRET || '',
  environment: (process.env.DELTA_ENVIRONMENT as any) || 'production',
  isConnected: false,
  isReadMode: true, // Default: READ MODE as mandated
  autoTradeEnabled: false, // Default: AUTO TRADE OFF as mandated
  tradingCapital: 10000,
  capitalLimit: 8000,
  maxDailyLoss: 500,
  maxOpenTrades: 3,
  lotSize: 1,
  minExpectedNetProfitPercent: 2.0,
  minNetEdgePercent: 0.8,
  minRiskReward: 1.8,
  leverageMode: 'MANUAL',
  manualLeverage: 10,
  tradingType: 'FUTURES_AND_OPTIONS',
  autoSaveHistory: true, // Default: auto-save trade/setup/performance records ON
  // 50% TP Progress Engine Settings
  tpProgressEnabled: true,
  tpProgressTriggerPercent: 50,
  tpProgressBookPercent: 30,
  tpProgressSlBufferPercent: 3,
  // Scanning Timeframe Settings
  scanningTimeframe: '15m',
  botScanningTimeframes: ['15m', '30m', '1h', '4h', '1d'],
  exchangeScanningTimeframes: ['15m', '30m', '1h', '4h', '1d'],
  // Price Change Distribution (PCD) Intelligence Settings
  pcdEnabled: true,
  pcdBreadthFilterEnabled: true,
  pcdChopProtectionEnabled: true,
  pcdMinBullishRatioForLongs: 40,
  pcdMaxBearishRatioForShorts: 40,
  pcdAllowOutliersInOppositeMarket: true,
  pcdConfluenceScoreBonus: 10,
  pcdMinOutlierGainPercent: 5.0,
  // Side Change / Opposite Order Settings
  sideChangeEnabled: false,
  sideChangeSlMode: 'SL',
  // Auto Close Order on Exchange Default Settings
  autoCloseOnExchangeEnabled: false,
  autoCloseProfitPnlPercent: null,
  autoCloseLossPnlPercent: null,
  autoCloseLotMode: 'ALL',
  autoCloseLotSize: 1,
};

export class BotDatabase {
  private dbPath: string;
  private data: BotDatabaseData;

  constructor(dbDir?: string) {
    const dir = dbDir || path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dbPath = path.join(dir, 'delta_bot_storage.json');
    this.data = this.loadInitialData();
    this.consolidateMultiTimeframeOpenTrades();
  }

  /**
   * Enforces single active OPEN trade per coin across multi-timeframe scans.
   * If multiple timeframes opened trades for the same coin, keeps the highest timeframe (e.g. 4h > 1h > 30m > 15m)
   * and safely consolidates/closes duplicates.
   */
  public consolidateMultiTimeframeOpenTrades(): void {
    const tfRank: Record<string, number> = { '1d': 5, '4h': 4, '1h': 3, '30m': 2, '15m': 1 };
    const openTradesByCoin = new Map<string, TradeRecord[]>();

    for (const t of this.data.trades) {
      if (t.status === 'OPEN') {
        const list = openTradesByCoin.get(t.coin) || [];
        list.push(t);
        openTradesByCoin.set(t.coin, list);
      }
    }

    let modified = false;
    for (const [coin, list] of openTradesByCoin.entries()) {
      if (list.length > 1) {
        list.sort((a, b) => {
          const rankA = tfRank[a.timeframe || '15m'] || 1;
          const rankB = tfRank[b.timeframe || '15m'] || 1;
          if (rankB !== rankA) return rankB - rankA;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        const primary = list[0];
        // Ensure primary has PCD and forensics if available from linked setup
        if (!primary.pcdReason && this.data.setups) {
          const s = this.data.setups.find((st) => st.id === primary.setupId || st.coin === primary.coin);
          if (s) {
            primary.whyFormed = primary.whyFormed || s.whyFormed;
            primary.primaryReason = primary.primaryReason || s.primaryReason;
            primary.supportingReasons = primary.supportingReasons || s.supportingReasons;
            primary.pcdReason = primary.pcdReason || s.supportingReasons?.find((r) => r.toLowerCase().includes('pcd'));
            primary.marketBreadthAtEntry = primary.marketBreadthAtEntry || 'Broad Market Checked';
            modified = true;
          }
        }

        for (let i = 1; i < list.length; i++) {
          const dup = list[i];
          dup.status = 'CLOSED';
          dup.closedAt = new Date().toISOString();
          dup.closeReason = 'MANUAL CLOSE';
          dup.executionNote = `Consolidated: Multi-timeframe duplicate trade closed. Retained primary ${primary.timeframe || '4h'} position.`;
          modified = true;
          console.log(`[Database] Consolidated duplicate multi-timeframe trade ${dup.tradeId} (${dup.timeframe}) for ${coin}. Retained primary trade ${primary.tradeId} (${primary.timeframe}).`);
        }
      } else if (list.length === 1) {
        const single = list[0];
        if (!single.pcdReason && this.data.setups) {
          const s = this.data.setups.find((st) => st.id === single.setupId || st.coin === single.coin);
          if (s) {
            single.whyFormed = single.whyFormed || s.whyFormed;
            single.primaryReason = single.primaryReason || s.primaryReason;
            single.supportingReasons = single.supportingReasons || s.supportingReasons;
            single.pcdReason = single.pcdReason || s.supportingReasons?.find((r) => r.toLowerCase().includes('pcd'));
            single.marketBreadthAtEntry = single.marketBreadthAtEntry || 'Broad Market Checked';
            modified = true;
          }
        }
      }
    }

    if (modified) {
      this.persist();
    }
  }

  private loadInitialData(): BotDatabaseData {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const parsed = JSON.parse(raw);
        const rawSetups: FutureSetup[] = (parsed.setups || []).map((s: FutureSetup) => {
          // CRITICAL INVARIANT: ENTRY PRICE === TRIGGER PRICE (LOCKED)
          const lockedPrice = s.entryPrice || s.triggerPrice || 0;
          return {
            ...s,
            entryPrice: lockedPrice,
            triggerPrice: lockedPrice,
          };
        });

        // Deduplicate setups strictly by coin + timeframe on load so each timeframe has dedicated setups
        const seenCoinTimeframe = new Set<string>();
        const setups: FutureSetup[] = [];
        for (const s of rawSetups) {
          const tfKey = `${(s.coin || '').trim().toUpperCase()}_${(s.timeframe || '15m').trim().toLowerCase()}`;
          if (!s.coin || seenCoinTimeframe.has(tfKey)) continue;
          seenCoinTimeframe.add(tfKey);
          setups.push(s);
        }

        const seenHistoryKeys = new Set<string>();
        const history: SetupHistoryRecord[] = [];

        for (const h of (parsed.history || [])) {
          // Strict mandate: Only real executed trades belong in Trade & Setup History (discard dummy setup forecasts)
          if (!h.tradeId && !h.orderId) {
            continue;
          }
          const openedAt = h.openedAt || h.timestamp || h.createdAt || new Date().toISOString();
          const closedAt = h.closedAt || h.timestamp || new Date().toISOString();
          const openMs = new Date(openedAt).getTime();
          const closeMs = new Date(closedAt).getTime();
          const durationMinutes = h.durationMinutes || Math.max(1, Math.round(Math.abs(closeMs - openMs) / 60000));
          const days = Math.floor(durationMinutes / 1440);
          const hours = Math.floor((durationMinutes % 1440) / 60);
          const mins = durationMinutes % 60;
          const durationFormatted = h.durationFormatted || (days > 0 ? `${days}d ${hours}h ${mins}m` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
          const isVirtual = String(h.orderId || '').startsWith('BOT_VIRTUAL') || h.executionType === 'BOT_VIRTUAL' || h.executionMode === 'BOT_SIMULATED';
          const executionType: 'EXCHANGE_LIVE' | 'BOT_VIRTUAL' = isVirtual ? 'BOT_VIRTUAL' : 'EXCHANGE_LIVE';
          const executionMode: 'EXCHANGE' | 'BOT_SIMULATED' = isVirtual ? 'BOT_SIMULATED' : 'EXCHANGE';
          const pcdReason = h.pcdReason || h.supportingReasons?.find((r: string) => r.toLowerCase().includes('pcd')) || 'PCD Breadth & Trend Clearance';
          const marketBreadthAtEntry = h.marketBreadthAtEntry || 'Delta Broad Market Scan';
          const pcdStatus = h.pcdStatus || (pcdReason.toLowerCase().includes('outlier') ? 'PCD OUTLIER' : 'PCD APPROVED');

          const hItem: SetupHistoryRecord = {
            ...h,
            openedAt,
            closedAt,
            timestamp: openedAt,
            durationMinutes,
            durationFormatted,
            executionType,
            executionMode,
            orderNotPlacedReason: h.orderNotPlacedReason,
            tpHitAt: h.tpHitAt,
            slHitAt: h.slHitAt,
            exchange: h.exchange || 'Delta',
            riskReward: h.riskReward || 5,
            margin: h.margin || h.capitalUsed,
            livePrice: h.livePrice,
            orderType: h.orderType || (isVirtual ? 'BOT' : 'EXCHANGE'),
            partialProfitBooked: h.partialProfitBooked,
            partialProfitBookedAt: h.partialProfitBookedAt,
            partialProfitBookedPrice: h.partialProfitBookedPrice,
            partialProfitBookedPnl: h.partialProfitBookedPnl,
            pcdReason,
            marketBreadthAtEntry,
            pcdStatus,
          };

          // Strict Deduplication on Startup:
          // Collapse duplicate entries (preferring real executed trade data over generic/dummy setup records)
          const coinKey = (hItem.coin || '').trim().toUpperCase();
          const openMinuteBucket = openedAt.slice(0, 16); // YYYY-MM-DDTHH:MM
          const dedupeKey = hItem.tradeId
            ? `TRD_${hItem.tradeId}`
            : hItem.orderId
            ? `ORD_${hItem.orderId}`
            : `${coinKey}_${hItem.timeframe || '15m'}_${openMinuteBucket}`;

          if (seenHistoryKeys.has(dedupeKey)) {
            // If current item has real tradeId/orderId and existing does not, upgrade it
            const existingIdx = history.findIndex((prev) => {
              if (hItem.tradeId && prev.tradeId === hItem.tradeId) return true;
              if (hItem.orderId && prev.orderId === hItem.orderId) return true;
              return prev.coin === hItem.coin && Math.abs(new Date(prev.openedAt).getTime() - openMs) < 600000;
            });
            if (existingIdx >= 0 && (hItem.tradeId || hItem.orderId) && (!history[existingIdx].tradeId && !history[existingIdx].orderId)) {
              history[existingIdx] = hItem;
            }
            continue;
          }

          seenHistoryKeys.add(dedupeKey);
          history.push(hItem);
        }

        const mergedConfig = { ...DEFAULT_CONFIG, ...(parsed.config || {}) };
        if (!mergedConfig.botScanningTimeframes || mergedConfig.botScanningTimeframes.length === 0) {
          mergedConfig.botScanningTimeframes = ['15m', '30m', '1h', '4h', '1d'];
        }
        if (!mergedConfig.exchangeScanningTimeframes || mergedConfig.exchangeScanningTimeframes.length === 0) {
          mergedConfig.exchangeScanningTimeframes = ['15m', '30m', '1h', '4h', '1d'];
        }

        return {
          config: mergedConfig,
          setups,
          trades: parsed.trades || [],
          history,
          arbitrageSetups: parsed.arbitrageSetups || [],
          errors: parsed.errors || [],
          forensics: parsed.forensics || [],
          commandLogs: parsed.commandLogs || [],
        };
      }
    } catch (e) {
      console.error('Error loading database file, initializing fresh:', e);
    }

    return {
      config: { ...DEFAULT_CONFIG },
      setups: [],
      trades: [],
      history: [],
      arbitrageSetups: [],
      errors: [],
      forensics: [],
      commandLogs: [],
    };
  }

  private persist(): void {
    try {
      let dataToSave = this.data;
      if (this.data.config.autoSaveHistory === false) {
        // Privacy / resource control: stop persisting trade, setup, history, and performance records to database disk
        dataToSave = {
          ...this.data,
          trades: [],
          history: [],
          forensics: [],
        };
      }
      const tempPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
      fs.renameSync(tempPath, this.dbPath);
    } catch (e) {
      console.error('Error saving database:', e);
    }
  }

  // Config Management
  public getConfig(): ExchangeConfig {
    return { ...this.data.config };
  }

  public updateConfig(newConfig: Partial<ExchangeConfig>): ExchangeConfig {
    this.data.config = { ...this.data.config, ...newConfig };
    this.persist();
    return { ...this.data.config };
  }

  // Setups Management
  public getSetups(): FutureSetup[] {
    const seen = new Set<string>();
    const result: FutureSetup[] = [];
    for (const s of this.data.setups) {
      if (!s.coin) continue;
      const tf = s.timeframe || '15m';
      const key = `${s.coin}_${tf}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(s);
    }
    return result;
  }

  public saveSetup(setup: FutureSetup): void {
    // RULE 1: ENTRY PRICE === TRIGGER PRICE (ONE single fixed price)
    const normalizedPrice = setup.entryPrice ?? setup.triggerPrice;
    setup.entryPrice = normalizedPrice;
    setup.triggerPrice = normalizedPrice;

    const tf = setup.timeframe || '15m';

    // RULE: Exactly ONE setup per coin PER timeframe!
    const idx = this.data.setups.findIndex(
      (s) => s.id === setup.id || (s.coin === setup.coin && (s.timeframe || '15m') === tf)
    );
    if (idx >= 0) {
      const existing = this.data.setups[idx];
      // RULE 2: ENTRY/TRIGGER/SL/TP1/TP2 ARE STRICTLY LOCKED ONCE CREATED
      // Market price changes MUST NEVER recalculate or shift these values!
      const lockedPrice = existing.entryPrice ?? existing.triggerPrice;

      this.data.setups[idx] = {
        ...setup,
        // IMMUTABLE LOCKED FIELDS
        id: existing.id,
        coin: existing.coin,
        timeframe: existing.timeframe || tf,
        direction: existing.direction,
        entryPrice: lockedPrice,
        triggerPrice: lockedPrice, // Always identical to entryPrice
        sl: existing.sl,
        tp1: existing.tp1,
        tp2: existing.tp2,
        createdAt: existing.createdAt,
        productId: existing.productId || setup.productId,
        // DYNAMIC FIELDS (Live market movement)
        currentPrice: setup.currentPrice,
        distanceToTrigger: setup.distanceToTrigger,
        distanceToTriggerPercent: setup.distanceToTriggerPercent,
        status: setup.status,
        triggeredAt: setup.triggeredAt || existing.triggeredAt,
        completedAt: setup.completedAt || existing.completedAt,
        rejectedAt: setup.rejectedAt ?? existing.rejectedAt,
        reason: setup.reason || existing.reason,
        indicatorConfirmations: setup.indicatorConfirmations || existing.indicatorConfirmations,
      };

      // Ensure no secondary duplicate of this coin + timeframe exists in array
      this.data.setups = this.data.setups.filter(
        (s, i) => i === idx || !(s.coin === setup.coin && (s.timeframe || '15m') === tf)
      );
    } else {
      // Before adding, filter out any existing setup with identical coin & timeframe
      this.data.setups = this.data.setups.filter(
        (s) => !(s.coin === setup.coin && (s.timeframe || '15m') === tf)
      );
      this.data.setups.unshift(setup);
      if (this.data.setups.length > 500) {
        this.data.setups.pop();
      }
    }
    this.persist();
  }

  public updateSetupStatus(setupId: string, status: FutureSetup['status']): void {
    const s = this.data.setups.find((item) => item.id === setupId);
    if (s) {
      s.status = status;
      if (status === 'TRIGGERED') s.triggeredAt = new Date().toISOString();
      if (['TP HIT', 'SL HIT', 'INVALIDATED', 'EXPIRED'].includes(status)) {
        s.completedAt = new Date().toISOString();
      }
      this.persist();
    }
  }

  // History Management with Strict Deduplication (No duplicate saves per coin/trade)
  public getHistory(): SetupHistoryRecord[] {
    const seen = new Set<string>();
    const deduplicated: SetupHistoryRecord[] = [];

    for (const h of this.data.history) {
      // Create a deterministic unique key per trade/coin occurrence
      const tf = h.timeframe || '15m';
      const openDateBucket = (h.openedAt || h.timestamp || '').slice(0, 16); // YYYY-MM-DDTHH:MM
      const uniqueKey = h.tradeId
        ? `TR_${h.tradeId}`
        : h.orderId
        ? `ORD_${h.orderId}`
        : `${h.coin}_${tf}_${openDateBucket}`;

      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        const closeReason = h.closeReason || (
          h.outcome === 'TP HIT' ? 'TP HIT' :
          h.outcome === 'SL HIT' ? 'SL HIT' :
          h.outcome === 'LIQUIDATED' ? 'LIQUIDATED' :
          'MANUAL CLOSE'
        );
        deduplicated.push({
          ...h,
          timeframe: tf,
          closeReason,
        });
      }
    }

    return deduplicated;
  }

  public saveHistory(record: SetupHistoryRecord): void {
    if (this.data.config.autoSaveHistory === false) {
      // Auto-save history disabled for user privacy / resource control
      return;
    }

    // Ensure timeframe is guaranteed
    if (!record.timeframe) {
      record.timeframe = this.data.config.scanningTimeframe || '15m';
    }

    // Ensure closeReason is explicitly defined
    if (!record.closeReason) {
      record.closeReason = (
        record.outcome === 'TP HIT' ? 'TP HIT' :
        record.outcome === 'SL HIT' ? 'SL HIT' :
        record.outcome === 'LIQUIDATED' ? 'LIQUIDATED' :
        'MANUAL CLOSE'
      );
    }

    // Strict deduplication check:
    // A single coin trade must NEVER be saved multiple times!
    const openTimeMs = new Date(record.openedAt || record.timestamp).getTime();
    const idx = this.data.history.findIndex((h) => {
      if (h.id === record.id) return true;
      if (record.tradeId && h.tradeId && h.tradeId === record.tradeId) return true;
      if (record.orderId && h.orderId && h.orderId === record.orderId) return true;
      if (
        h.coin === record.coin &&
        record.setupId &&
        h.setupId === record.setupId
      ) {
        return true;
      }
      // Same coin with open timestamp within 10 minutes
      if (
        h.coin === record.coin &&
        Math.abs(new Date(h.openedAt || h.timestamp).getTime() - openTimeMs) < 600000
      ) {
        return true;
      }
      return false;
    });

    if (idx >= 0) {
      // Update existing record with real metrics rather than creating a duplicate
      this.data.history[idx] = {
        ...this.data.history[idx],
        ...record,
      };
    } else {
      this.data.history.unshift(record);
      if (this.data.history.length > 500) {
        this.data.history.pop();
      }
    }
    this.persist();
  }

  public clearHistory(): void {
    this.data.history = [];
    this.persist();
  }

  // Trades Management
  public getTrades(): TradeRecord[] {
    return [...this.data.trades];
  }

  public saveTrade(trade: TradeRecord): void {
    const idx = this.data.trades.findIndex((t) => t.tradeId === trade.tradeId);
    if (idx >= 0) {
      this.data.trades[idx] = trade;
    } else {
      this.data.trades.unshift(trade);
    }
    this.persist();
  }

  /**
   * Clears trades with optional filters:
   * - date: YYYY-MM-DD
   * - status: 'CLOSED_ONLY' (keeps active open trades) or 'ALL' (clears all)
   */
  public clearTrades(options?: { date?: string; status?: 'ALL' | 'CLOSED_ONLY' }): { removed: number; remaining: number } {
    const beforeCount = this.data.trades.length;
    const filterDate = options?.date;
    const onlyClosed = options?.status === 'CLOSED_ONLY';

    this.data.trades = this.data.trades.filter((t) => {
      const isClosed = ['CLOSED', 'TP HIT', 'SL HIT', 'FAILED'].includes(t.status);
      const tradeDate = t.createdAt ? new Date(t.createdAt).toISOString().split('T')[0] : '';

      if (filterDate && tradeDate !== filterDate) {
        return true; // Keep trades from other dates
      }

      if (onlyClosed && !isClosed) {
        return true; // Preserve OPEN trades when clearing closed orders
      }

      return false; // Remove trade
    });

    const removed = beforeCount - this.data.trades.length;
    this.persist();
    return { removed, remaining: this.data.trades.length };
  }

  /**
   * 1-Click Day Record Purge:
   * Removes all trades and history associated with a specific calendar date (YYYY-MM-DD)
   */
  public clearDayRecords(date: string): { removedTrades: number; removedHistory: number } {
    const tradesBefore = this.data.trades.length;
    this.data.trades = this.data.trades.filter((t) => {
      const d = t.createdAt ? new Date(t.createdAt).toISOString().split('T')[0] : '';
      return d !== date;
    });
    const removedTrades = tradesBefore - this.data.trades.length;

    const histBefore = this.data.history.length;
    this.data.history = this.data.history.filter((h) => {
      const d1 = h.openedAt ? new Date(h.openedAt).toISOString().split('T')[0] : '';
      const d2 = h.timestamp ? new Date(h.timestamp).toISOString().split('T')[0] : '';
      const d3 = h.closedAt ? new Date(h.closedAt).toISOString().split('T')[0] : '';
      return d1 !== date && d2 !== date && d3 !== date;
    });
    const removedHistory = histBefore - this.data.history.length;

    this.persist();
    return { removedTrades, removedHistory };
  }

  /**
   * Clears all trades and setup history across all days
   */
  public clearAllTradesAndHistory(options?: { onlyClosed?: boolean }): { removedTrades: number; removedHistory: number } {
    const tradesBefore = this.data.trades.length;
    if (options?.onlyClosed) {
      this.data.trades = this.data.trades.filter((t) => t.status === 'OPEN');
    } else {
      this.data.trades = [];
    }
    const removedTrades = tradesBefore - this.data.trades.length;

    const removedHistory = this.data.history.length;
    this.data.history = [];

    this.persist();
    return { removedTrades, removedHistory };
  }

  // Arbitrage Setups
  public getArbitrageSetups(): ArbitrageSetup[] {
    return [...this.data.arbitrageSetups];
  }

  public saveArbitrageSetups(setups: ArbitrageSetup[]): void {
    this.data.arbitrageSetups = setups.slice(0, 100);
    this.persist();
  }

  // Errors Management
  public getErrors(): BotErrorRecord[] {
    return [...this.data.errors];
  }

  public logError(err: Omit<BotErrorRecord, 'errorId' | 'timestamp'>): BotErrorRecord {
    const record: BotErrorRecord = {
      ...err,
      errorId: `ERR_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
    };
    this.data.errors.unshift(record);
    if (this.data.errors.length > 300) {
      this.data.errors.pop();
    }
    this.persist();
    return record;
  }

  public clearErrors(): void {
    this.data.errors = [];
    this.persist();
  }

  // Forensics Memory
  public getForensics(): HistoricalForensicMove[] {
    return [...this.data.forensics];
  }

  public saveForensics(record: HistoricalForensicMove): void {
    const exists = this.data.forensics.some((f) => f.symbol === record.symbol && f.detectedAt === record.detectedAt);
    if (!exists) {
      this.data.forensics.unshift(record);
      if (this.data.forensics.length > 500) {
        this.data.forensics.pop();
      }
      this.persist();
    }
  }

  // Command Logs (Auto-resets daily at 12:00 AM Midnight)
  private pruneCommandLogsForMidnight(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.data.commandLogs && this.data.commandLogs.length > 0) {
      // Check if the most recent log is from a previous calendar day
      const latestLogDate = (this.data.commandLogs[0]?.timestamp || '').split('T')[0];
      if (latestLogDate && latestLogDate !== today) {
        // Midnight transition has occurred - reset logs and start fresh daily record!
        this.data.commandLogs = [
          {
            id: `CMD_MIDNIGHT_RESET_${Date.now()}`,
            timestamp: new Date().toISOString(),
            command: 'DAILY_MIDNIGHT_AUTO_RESET',
            output: `[12:00 AM MIDNIGHT ROTATION] Execution Output Stream reset for new calendar day (${today}). Starting fresh command and execution log.`,
            status: 'SUCCESS',
          },
        ];
        this.persist();
      }
    }
  }

  public logCommand(cmd: string, output: string, status: 'SUCCESS' | 'ERROR'): void {
    this.pruneCommandLogsForMidnight();
    this.data.commandLogs.unshift({
      id: `CMD_${Date.now()}`,
      timestamp: new Date().toISOString(),
      command: cmd,
      output,
      status,
    });
    if (this.data.commandLogs.length > 100) {
      this.data.commandLogs.pop();
    }
    this.persist();
  }

  public getCommandLogs() {
    this.pruneCommandLogsForMidnight();
    return [...this.data.commandLogs];
  }
}
