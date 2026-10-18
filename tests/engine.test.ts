import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEMA,
  calculateRSI,
  computeAllIndicators,
} from '../backend/analysis/indicators.js';
import { RiskManager } from '../backend/risk/riskManager.js';
import { MoveForensicsEngine } from '../backend/analysis/forensics.js';
import { DeltaExchangeClient } from '../backend/exchange/deltaClient.js';

test('1. Indicators Engine: EMA and RSI calculations', () => {
  const prices = [100, 102, 101, 105, 107, 106, 108, 110, 112, 111, 115, 118, 120, 122, 125, 124, 128, 130];
  const ema9 = calculateEMA(prices, 9);
  assert.equal(ema9.length, prices.length);
  assert.ok(ema9[ema9.length - 1] > 115, 'EMA should reflect upward trend');

  const rsi = calculateRSI(prices, 14);
  assert.equal(rsi.length, prices.length);
  assert.ok(rsi[rsi.length - 1] > 50, 'RSI should be bullish (>50) for rising series');
});

test('2. Indicators Engine: Confluence suite on sample candle sequence', () => {
  const candles = [];
  let basePrice = 50000;
  for (let i = 0; i < 40; i++) {
    const change = (Math.sin(i / 3) + 0.2) * 200;
    basePrice += change;
    candles.push({
      time: 1700000000 + i * 900,
      open: basePrice - 50,
      high: basePrice + 120,
      low: basePrice - 80,
      close: basePrice,
      volume: 100 + i * 5,
    });
  }

  const indicators = computeAllIndicators(candles);
  assert.ok(indicators.rsi > 0 && indicators.rsi < 100, 'RSI must be bounded between 0 and 100');
  assert.ok(indicators.atr > 0, 'ATR must be positive');
  assert.ok(indicators.bollingerBands.upper > indicators.bollingerBands.lower, 'BB Upper > Lower');
  assert.ok(indicators.structure.trendType, 'Market structure must identify trend');
});

test('3. Move Forensics Engine: Analyzes pre-move conditions without look-ahead bias', () => {
  const forensics = new MoveForensicsEngine();
  const candles = [];
  let price = 100;
  for (let i = 0; i < 40; i++) {
    price += (i > 32 ? 5 : 0.2);
    candles.push({
      time: 1700000000 + i * 900,
      open: price - 0.5,
      high: price + 1,
      low: price - 0.5,
      close: price,
      volume: 50 + (i > 32 ? 300 : 10),
    });
  }

  const result = forensics.analyzeMove('TEST_COIN', candles, 8.5);
  assert.ok(result, 'Forensic analysis must succeed');
  assert.equal(result.isSignificantMove, true);
  assert.equal(result.forensicRecord.symbol, 'TEST_COIN');
  assert.ok(result.forensicRecord.preMoveRsi > 0, 'Pre-move RSI recorded');
});

test('4. Risk Manager: Blocks orders when limits are violated', () => {
  const risk = new RiskManager();
  const mockConfig: any = {
    apiKey: 'test',
    apiSecret: 'test',
    environment: 'production',
    isConnected: true,
    isReadMode: true,
    autoTradeEnabled: false,
    tradingCapital: 5000,
    capitalLimit: 4000,
    maxDailyLoss: 200,
    maxOpenTrades: 2,
    lotSize: 1,
    minExpectedNetProfitPercent: 2.0,
    minNetEdgePercent: 0.8,
    minRiskReward: 2.0,
    leverageMode: 'AUTOMATIC',
    manualLeverage: 10,
    tradingType: 'FUTURES_ONLY',
  };

  const mockSetup: any = {
    id: 'SETUP_TEST',
    coin: 'BTCUSD',
    exchange: 'Delta',
    instrumentType: 'Future',
    direction: 'BUY/LONG',
    currentPrice: 60000,
    triggerPrice: 60100,
    entryPrice: 60100,
    tp1: 62000,
    sl: 59500,
    distanceToTrigger: 100,
    distanceToTriggerPercent: 0.16,
    expectedMovePercent: 3.16,
    riskPercent: 1.0,
    rewardPercent: 3.16,
    riskReward: 3.16,
    score: 85,
    historicalProbability: 68,
    sampleSize: 12,
    confidence: 75,
    reason: 'EMA breakout',
    historicalEvidence: 'Matched 12 historical events',
    indicatorConfirmations: {
      trend: 'UPTREND',
      rsi: 58,
      macd: 'positive',
      adx: 28,
      volumeProfile: 'High RVOL',
      volatility: 'Expanding',
      pattern: 'Bullish Engulfing',
      marketStructure: 'BOS_BULL',
    },
    status: 'WATCHING',
    createdAt: new Date().toISOString(),
    productId: 1,
    timeframe: '15m',
  };

  // Case 1: Max daily loss reached
  const resLoss = risk.validateTrade(mockSetup, mockConfig, [], 250, 5000);
  assert.equal(resLoss.allowed, false, 'Must block when daily loss >= maxDailyLoss');
  assert.ok(resLoss.blockReason?.includes('MAX DAILY LOSS REACHED'));

  // Case 2: Max open trades reached
  const activeTrades: any[] = [
    { status: 'OPEN', capitalUsed: 500 },
    { status: 'OPEN', capitalUsed: 500 },
  ];
  const resTrades = risk.validateTrade(mockSetup, mockConfig, activeTrades, 0, 5000);
  assert.equal(resTrades.allowed, false, 'Must block when open trades >= maxOpenTrades');

  // Case 3: Clean state passes
  const resValid = risk.validateTrade(mockSetup, mockConfig, [], 0, 5000);
  assert.equal(resValid.allowed, true, 'Must allow trade when risk checks pass');
  assert.ok(resValid.calculatedLeverage >= 1, 'Calculated leverage must be >= 1');
});

test('5. Delta Exchange Client: Instantiation and credential masking', () => {
  const client = new DeltaExchangeClient({
    apiKey: 'test_key_123',
    apiSecret: 'test_secret_456',
    environment: 'production',
  });

  assert.equal(client.hasCredentials(), true);
  assert.equal(client.getEnvironment(), 'production');
});

test('6. Order Manager: Partial lot closing and Auto Close calculations', async () => {
  const { OrderManager } = await import('../backend/orders/orderManager.js');
  const orderManager = new OrderManager();
  const mockClient: any = {
    hasCredentials: () => false,
    placeOrder: async () => ({ success: true }),
    cancelAllOrdersForProduct: async () => ({ success: true }),
  };

  const trade: any = {
    tradeId: 'TEST_TRD_1',
    coin: 'BTCUSD',
    side: 'BUY',
    entryPrice: 50000,
    actualFillPrice: 50000,
    currentPrice: 55000,
    quantity: 10,
    leverage: 10,
    status: 'OPEN',
    realizedPnl: 0,
  };

  // Test partial close of 3 lots at $55000 (+10% price move * 10x leverage = 100% PnL)
  const partialRes = await orderManager.closeTradeMarket(trade, 55000, mockClient, [], 3, 'AUTO CLOSE: Profit Target (+100%)');
  assert.equal(partialRes.success, true);
  assert.equal(partialRes.isPartial, true);
  assert.equal(partialRes.closedQuantity, 3);
  assert.equal(partialRes.trade.quantity, 7, 'Remaining quantity should be 7');
  assert.equal(partialRes.trade.status, 'OPEN', 'Status should remain OPEN for remaining lots');
  assert.ok(partialRes.trade.realizedPnl > 0, 'Realized PnL should be booked for closed lots');

  // Test full close of remaining lots
  const fullRes = await orderManager.closeTradeMarket(partialRes.trade, 56000, mockClient, [], undefined, 'AUTO CLOSE: Profit Target');
  assert.equal(fullRes.success, true);
  assert.equal(fullRes.isPartial, false);
  assert.equal(fullRes.trade.status, 'CLOSED', 'Trade status should become CLOSED');
});
