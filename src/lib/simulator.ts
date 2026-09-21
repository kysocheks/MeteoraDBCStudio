import type { DbcConfig } from "./protocol";
import { configSchema, MIGRATION_FEES } from "./protocol";

export type SwapMode = "Exact-In" | "Exact-Out" | "Partial-Fill";
export type SwapSide = "Buy" | "Sell";
export type LaunchScenario = "NYSE / xStocks Bell Open" | "Bot Sniper Wave (Slot 0-50)" | "Organic Conviction Climb";
export type PostGraduationStack = "Compounding Liquidity DAMM v2 Pool" | "Dynamic AMM v2 (DAMM v2 Locked LP)" | "DLMM Concentrated Bin Routing";

export function launchScenarioMetrics(progressPct: number, scenario: LaunchScenario, feeDecaySlots: number) {
  const progress = Math.max(0, Math.min(1, Number.isFinite(progressPct) ? progressPct / 100 : 0));
  const botWave = scenario === "Bot Sniper Wave (Slot 0-50)";
  const organic = scenario === "Organic Conviction Climb";
  return {
    slot: botWave ? Math.round(progress * 50) : Math.round(progress * feeDecaySlots * (organic ? 1.35 : 1)),
    demandMultiplier: botWave ? 1.35 : organic ? 0.72 : 1,
  };
}

export function feeAtSlot(config: DbcConfig, slot: number): number {
  if (slot <= config.feeCliffSlots) return config.startFeeBps;
  if (slot >= config.feeDecaySlots) return config.endFeeBps;
  const progress = (slot - config.feeCliffSlots) / (config.feeDecaySlots - config.feeCliffSlots);
  return config.startFeeBps + (config.endFeeBps - config.startFeeBps) * progress;
}

function shape(curve: DbcConfig["curve"], progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  switch (curve) {
    case "Flat": return 1 + p * 0.13;
    case "Exponential": return Math.exp(p * 1.2);
    case "Long Curve": return 1 + Math.pow(p, 2.3) * 1.2;
    case "Stepped Institutional": return 1 + Math.min(3, Math.floor(p * 4)) * 0.18 + (p % 0.25) * 0.08;
  }
}

export function curvePrice(config: DbcConfig, raisedQuote: number, curve = config.curve): number {
  const quote = Math.max(0, raisedQuote);
  const q0 = config.initialVirtualQuoteReserve;
  return ((q0 + quote) ** 2 / (q0 * config.initialVirtualBaseReserve)) * shape(curve, quote / config.graduationThreshold);
}

export function sqrtPrice(config: DbcConfig, raisedQuote: number): number { return Math.sqrt(curvePrice(config, raisedQuote)); }

// Numerical integration of token output along the marginal price curve.
export function baseForQuote(config: DbcConfig, fromQuote: number, toQuote: number): number {
  if (toQuote === fromQuote) return 0;
  const segments = 128;
  const step = (toQuote - fromQuote) / segments;
  let sum = 1 / curvePrice(config, fromQuote) + 1 / curvePrice(config, toQuote);
  for (let i = 1; i < segments; i++) sum += (i % 2 ? 4 : 2) / curvePrice(config, fromQuote + i * step);
  return (step / 3) * sum;
}

export type SwapQuote = {
  side: SwapSide; mode: SwapMode; amountIn: number; amountOut: number; requestedAmount: number;
  executedAmount: number; partialFill: boolean; feeBps: number; tradingFee: number;
  protocolFee: number; referralFee: number; creatorFee: number; lpFee: number;
  priceBefore: number; priceAfter: number; priceImpactPct: number; postSwapSqrtPrice: number;
  progressBeforePct: number; progressAfterPct: number; curveComplete: boolean; minAmountOut: number;
  executionVenue: "DBC" | "MIGRATED_POOL"; postGraduationStack?: PostGraduationStack;
};

function quoteMigratedPool(config: DbcConfig, params: { side: SwapSide; mode: SwapMode; amount: number; slippageBps: number; postGraduationStack?: PostGraduationStack }): SwapQuote {
  const { side, mode, amount, slippageBps, postGraduationStack } = params;
  const feeBps = MIGRATION_FEES[config.migrationFeeOption].bps;
  const feeRate = feeBps / 10000;
  const priceBefore = curvePrice(config, config.graduationThreshold);
  const quoteReserve = config.graduationThreshold;
  const baseReserve = quoteReserve / priceBefore;
  let amountIn = 0;
  let amountOut = 0;
  let tradingFee = 0;
  let quoteAfter = quoteReserve;
  let baseAfter = baseReserve;

  if (side === "Buy") {
    if (mode === "Exact-Out") {
      if (amount >= baseReserve) throw new Error("Requested output exceeds migrated pool liquidity");
      const netQuote = quoteReserve * amount / (baseReserve - amount);
      amountIn = netQuote / (1 - feeRate);
      tradingFee = amountIn - netQuote;
      amountOut = amount;
      quoteAfter += netQuote;
      baseAfter -= amountOut;
    } else {
      amountIn = amount;
      tradingFee = amountIn * feeRate;
      const netQuote = amountIn - tradingFee;
      amountOut = baseReserve * netQuote / (quoteReserve + netQuote);
      quoteAfter += netQuote;
      baseAfter -= amountOut;
    }
  } else if (mode === "Exact-Out") {
    if (amount >= quoteReserve * (1 - feeRate)) throw new Error("Requested quote output exceeds migrated pool liquidity");
    const grossQuote = amount / (1 - feeRate);
    amountIn = baseReserve * grossQuote / (quoteReserve - grossQuote);
    amountOut = amount;
    tradingFee = grossQuote - amountOut;
    quoteAfter -= grossQuote;
    baseAfter += amountIn;
  } else {
    amountIn = amount;
    const grossQuote = quoteReserve * amountIn / (baseReserve + amountIn);
    tradingFee = grossQuote * feeRate;
    amountOut = grossQuote - tradingFee;
    quoteAfter -= grossQuote;
    baseAfter += amountIn;
  }

  const protocolFee = tradingFee * config.protocolFeeShareBps / 10000;
  const referralFee = tradingFee * config.partnerFeeShareBps / 10000;
  const creatorFee = tradingFee * config.creatorFeeShareBps / 10000;
  const lpFee = Math.max(0, tradingFee - protocolFee - referralFee - creatorFee);
  const priceAfter = quoteAfter / baseAfter;
  return {
    side, mode, amountIn, amountOut, requestedAmount: amount,
    executedAmount: mode === "Exact-Out" ? amountOut : amountIn,
    partialFill: false, feeBps, tradingFee, protocolFee, referralFee, creatorFee, lpFee,
    priceBefore, priceAfter, priceImpactPct: (priceAfter / priceBefore - 1) * 100,
    postSwapSqrtPrice: Math.sqrt(priceAfter), progressBeforePct: 100, progressAfterPct: 100,
    curveComplete: true, minAmountOut: amountOut * (1 - slippageBps / 10000),
    executionVenue: "MIGRATED_POOL", postGraduationStack,
  };
}

export function quoteSwap(configInput: DbcConfig, params: { side: SwapSide; mode: SwapMode; amount: number; raisedQuote: number; slot: number; slippageBps: number; postGraduationStack?: PostGraduationStack }): SwapQuote {
  const config = configSchema.parse(configInput);
  const { side, mode, amount, slot, slippageBps } = params;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Trade amount must be positive");
  if (!Number.isFinite(params.raisedQuote) || params.raisedQuote < 0 || params.raisedQuote > config.graduationThreshold) throw new Error("Invalid raised quote reserve");
  if (!Number.isFinite(slot) || slot < 0) throw new Error("Invalid slot");
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error("Slippage must be between 0 and 5000 bps");
  const raised = params.raisedQuote;
  if (raised >= config.graduationThreshold - 1e-9) return quoteMigratedPool(config, { side, mode, amount, slippageBps, postGraduationStack: params.postGraduationStack });
  const feeBps = feeAtSlot(config, slot);
  const feeRate = feeBps / 10000;
  const before = curvePrice(config, raised);
  let amountIn = 0, amountOut = 0, nextRaised = raised, partialFill = false;

  if (side === "Buy") {
    let netQuote: number;
    if (mode === "Exact-Out") {
      const maxBase = baseForQuote(config, raised, config.graduationThreshold);
      if (amount > maxBase) throw new Error("Requested output exceeds remaining curve liquidity");
      let lo = raised, hi = config.graduationThreshold;
      for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (baseForQuote(config, raised, mid) < amount) lo = mid; else hi = mid; }
      netQuote = hi - raised;
      amountIn = netQuote / (1 - feeRate);
    } else {
      const requestedNet = amount * (1 - feeRate);
      netQuote = Math.min(requestedNet, config.graduationThreshold - raised);
      amountIn = netQuote / (1 - feeRate);
      partialFill = netQuote + 1e-9 < requestedNet;
    }
    nextRaised = raised + netQuote;
    amountOut = baseForQuote(config, raised, nextRaised);
  } else {
    let quoteOut: number;
    if (mode === "Exact-Out") {
      if (amount > raised * (1 - feeRate)) throw new Error("Requested quote output exceeds available curve reserve");
      quoteOut = amount;
      nextRaised = raised - quoteOut / (1 - feeRate);
      amountIn = baseForQuote(config, nextRaised, raised);
    } else {
      const maxBase = baseForQuote(config, 0, raised);
      const executableBase = Math.min(amount, maxBase);
      partialFill = executableBase + 1e-9 < amount;
      let lo = 0, hi = raised;
      for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (baseForQuote(config, mid, raised) > executableBase) lo = mid; else hi = mid; }
      nextRaised = hi;
      amountIn = executableBase;
      quoteOut = (raised - nextRaised) * (1 - feeRate);
    }
    amountOut = quoteOut;
  }
  const grossQuote = side === "Buy" ? amountIn : (raised - nextRaised);
  const tradingFee = grossQuote * feeRate;
  const protocolFee = tradingFee * config.protocolFeeShareBps / 10000;
  const referralFee = tradingFee * config.partnerFeeShareBps / 10000;
  const creatorFee = tradingFee * config.creatorFeeShareBps / 10000;
  const lpFee = Math.max(0, tradingFee - protocolFee - referralFee - creatorFee);
  const after = curvePrice(config, nextRaised);
  return {
    side, mode, amountIn, amountOut, requestedAmount: amount, executedAmount: mode === "Exact-Out" ? amountOut : amountIn,
    partialFill, feeBps, tradingFee, protocolFee, referralFee, creatorFee, lpFee,
    priceBefore: before, priceAfter: after, priceImpactPct: (after / before - 1) * 100,
    postSwapSqrtPrice: Math.sqrt(after), progressBeforePct: raised / config.graduationThreshold * 100,
    progressAfterPct: nextRaised / config.graduationThreshold * 100,
    curveComplete: nextRaised >= config.graduationThreshold - 1e-9,
    minAmountOut: amountOut * (1 - slippageBps / 10000), executionVenue: "DBC",
  };
}

export function curveSeries(config: DbcConfig, curve = config.curve, count = 49) {
  return Array.from({ length: count }, (_, i) => ({ progress: i / (count - 1), price: curvePrice(config, config.graduationThreshold * i / (count - 1), curve) }));
}
