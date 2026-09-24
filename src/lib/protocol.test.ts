import { describe, expect, it } from "vitest";
import { base58Address, configSchema, DBC_PROGRAM_ID, MIGRATION_FEES, QUOTE_TOKENS, toEventConfig } from "./protocol";
import { PRESETS } from "./presets";
import { curvePrice, feeAtSlot, launchScenarioMetrics, quoteSwap } from "./simulator";

const cfg = PRESETS[0];
describe("protocol constants", () => {
  it("uses the official DBC program id", () => expect(DBC_PROGRAM_ID).toBe("dbcij3LWUppWqq96dh6gJWwBifmcgFLSB5D4DuSMaqN"));
  it("contains five quote tokens", () => expect(Object.keys(QUOTE_TOKENS)).toHaveLength(5));
  it("contains six migration fee keys", () => expect(MIGRATION_FEES).toHaveLength(6));
});
describe("config validation", () => {
  it("accepts a preset", () => expect(configSchema.safeParse(cfg).success).toBe(true));
  it("rejects below threshold", () => expect(configSchema.safeParse({ ...cfg, graduationThreshold: 1 }).success).toBe(false));
  it("rejects rising steady fee", () => expect(configSchema.safeParse({ ...cfg, endFeeBps: 999 }).success).toBe(false));
  it("rejects fee shares over 100%", () => expect(configSchema.safeParse({ ...cfg, creatorFeeShareBps: 9000, partnerFeeShareBps: 9000 }).success).toBe(false));
  it("exports an event config", () => expect(toEventConfig(cfg).schema).toBe("EvtCreateConfigV2"));
  it("rejects invalid fee option", () => expect(configSchema.safeParse({ ...cfg, migrationFeeOption: 9 }).success).toBe(false));
  it("rejects cliff after decay", () => expect(configSchema.safeParse({ ...cfg, feeCliffSlots: 2000 }).success).toBe(false));
  it("validates base58 account strings", () => expect(base58Address.safeParse(DBC_PROGRAM_ID).success).toBe(true));
  it("rejects malformed account strings", () => expect(base58Address.safeParse("not-an-account").success).toBe(false));
});
describe("curve and swaps", () => {
  it("curve rises with quote reserve", () => expect(curvePrice(cfg, cfg.graduationThreshold)).toBeGreaterThan(curvePrice(cfg, 0)));
  it("fee holds at cliff", () => expect(feeAtSlot(cfg, cfg.feeCliffSlots)).toBe(cfg.startFeeBps));
  it("fee decays to steady state", () => expect(feeAtSlot(cfg, cfg.feeDecaySlots)).toBe(cfg.endFeeBps));
  it("quotes a buy", () => { const q = quoteSwap(cfg, { side: "Buy", mode: "Exact-In", amount: 1000, raisedQuote: 5000, slot: 200, slippageBps: 50 }); expect(q.amountOut).toBeGreaterThan(0); expect(q.tradingFee).toBeGreaterThan(0); });
  it("quotes a sell", () => { const q = quoteSwap(cfg, { side: "Sell", mode: "Exact-In", amount: 10000, raisedQuote: 5000, slot: 200, slippageBps: 50 }); expect(q.amountOut).toBeGreaterThan(0); });
  it("honors exact out", () => { const q = quoteSwap(cfg, { side: "Buy", mode: "Exact-Out", amount: 1000, raisedQuote: 5000, slot: 200, slippageBps: 50 }); expect(q.amountOut).toBeCloseTo(1000, 5); });
  it("reports progress", () => { const q = quoteSwap(cfg, { side: "Buy", mode: "Exact-In", amount: 100, raisedQuote: 5000, slot: 200, slippageBps: 50 }); expect(q.progressAfterPct).toBeGreaterThan(q.progressBeforePct); });
  it("fee never falls below steady state", () => expect(feeAtSlot(cfg, cfg.feeDecaySlots * 2)).toBe(cfg.endFeeBps));
  it("fee remains at launch before cliff", () => expect(feeAtSlot(cfg, 0)).toBe(cfg.startFeeBps));
  it("rejects a negative swap", () => expect(() => quoteSwap(cfg, { side: "Buy", mode: "Exact-In", amount: -1, raisedQuote: 5000, slot: 200, slippageBps: 50 })).toThrow());
  it("rejects excessive slippage", () => expect(() => quoteSwap(cfg, { side: "Buy", mode: "Exact-In", amount: 10, raisedQuote: 5000, slot: 200, slippageBps: 5001 })).toThrow());
  it("routes post-graduation partial-fill buys through the selected migrated pool", () => {
    const quote = quoteSwap(cfg, { side: "Buy", mode: "Partial-Fill", amount: 1000, raisedQuote: cfg.graduationThreshold, slot: cfg.feeDecaySlots, slippageBps: 50, postGraduationStack: "Compounding Liquidity DAMM v2 Pool" });
    expect(quote.executionVenue).toBe("MIGRATED_POOL");
    expect(quote.postGraduationStack).toBe("Compounding Liquidity DAMM v2 Pool");
    expect(quote.amountOut).toBeGreaterThan(0);
    expect(quote.tradingFee).toBeGreaterThan(0);
    expect(quote.feeBps).toBe(MIGRATION_FEES[cfg.migrationFeeOption].bps);
  });
  it("honors exact-out amounts in the migrated pool", () => {
    const quote = quoteSwap(cfg, { side: "Buy", mode: "Exact-Out", amount: 100, raisedQuote: cfg.graduationThreshold, slot: 0, slippageBps: 25 });
    expect(quote.amountOut).toBe(100);
    expect(quote.amountIn).toBeGreaterThan(0);
    expect(quote.tradingFee).toBeGreaterThan(0);
    expect(quote.executionVenue).toBe("MIGRATED_POOL");
  });
  it("routes migrated pool sells with nonzero output and fee", () => {
    const quote = quoteSwap(cfg, { side: "Sell", mode: "Exact-In", amount: 1000, raisedQuote: cfg.graduationThreshold, slot: 0, slippageBps: 50, postGraduationStack: "DLMM Concentrated Bin Routing" });
    expect(quote.amountOut).toBeGreaterThan(0);
    expect(quote.tradingFee).toBeGreaterThan(0);
    expect(quote.executionVenue).toBe("MIGRATED_POOL");
    expect(quote.postGraduationStack).toBe("DLMM Concentrated Bin Routing");
  });
  it("keeps pre-graduation trades on the DBC curve", () => {
    const quote = quoteSwap(cfg, { side: "Buy", mode: "Partial-Fill", amount: 1000, raisedQuote: cfg.graduationThreshold * 0.99, slot: 0, slippageBps: 50 });
    expect(quote.executionVenue).toBe("DBC");
  });
});
describe("launch replay scenarios", () => {
  it("maps xStocks bell-open progress onto the configured decay window", () => expect(launchScenarioMetrics(50, "NYSE / xStocks Bell Open", 1200)).toEqual({ slot: 600, demandMultiplier: 1 }));
  it("keeps the sniper-wave window within its first 50 slots", () => expect(launchScenarioMetrics(100, "Bot Sniper Wave (Slot 0-50)", 1200)).toEqual({ slot: 50, demandMultiplier: 1.35 }));
  it("extends organic conviction fee decay and lowers demand pressure", () => expect(launchScenarioMetrics(100, "Organic Conviction Climb", 1200)).toEqual({ slot: 1620, demandMultiplier: 0.72 }));
});
describe("preset integrity", () => {
  it("ships 12 presets", () => expect(PRESETS).toHaveLength(12));
  it("covers all asset classes", () => expect(new Set(PRESETS.map((p) => p.assetClass)).size).toBe(4));
  it("has unique ids", () => expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length));
  for (const preset of PRESETS) it(`${preset.id} is valid`, () => expect(configSchema.safeParse(preset).success).toBe(true));
});
