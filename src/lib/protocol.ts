import { z } from "zod";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcgFLSB5D4DuSMaqN";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DBC_PROGRAM_SNAPSHOT = {
  address: DBC_PROGRAM_ID,
  network: "mainnet-beta",
  owner: "BPFLoaderUpgradeab1e11111111111111111111111",
  executable: true,
  lamports: 1141440,
  dataSize: 36,
  rentEpoch: "18446744073709551615",
  source: "snapshot" as const,
  snapshotAt: "2026-09-27",
};
export const QUOTE_TOKENS = {
  SOL: { symbol: "SOL", name: "Wrapped SOL", mint: "So11111111111111111111111111111111111111112", minThreshold: 10, decimals: 9 },
  USDC: { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", minThreshold: 750, decimals: 6 },
  MET: { symbol: "MET", name: "Meteora MET", mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", minThreshold: 1500, decimals: 6 },
  JUP: { symbol: "JUP", name: "Jupiter JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", minThreshold: 1500, decimals: 6 },
  JupUSD: { symbol: "JupUSD", name: "JupUSD", mint: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", minThreshold: 750, decimals: 6 },
} as const;
export type QuoteSymbol = keyof typeof QUOTE_TOKENS;
export const MIGRATION_FEES = [
  { option: 0, bps: 25, key: "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd" },
  { option: 1, bps: 30, key: "HBxB8Lf14Yj8pqeJ8C4qDb5ryHL7xwpuykz31BLNYr7S" },
  { option: 2, bps: 100, key: "7v5vBdUQHTNeqk1HnduiXcgbvCyVEZ612HLmYkQoAkik" },
  { option: 3, bps: 200, key: "EkvP7d5yKxovj884d2DwmBQbrHUWRLGK6bympzrkXGja" },
  { option: 4, bps: 400, key: "9EZYAJrcqNWNQzP2trzZesP7XKMHA1jEomHzbRsdX8R2" },
  { option: 5, bps: 600, key: "8cdKo87jZU2R12KY1BUjjRPwyjgdNjLGqSGQyrDshhud" },
] as const;

export const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Enter a valid Solana base58 address");
export const curveSchema = z.enum(["Flat", "Exponential", "Long Curve", "Stepped Institutional"]);
export const configSchema = z.object({
  name: z.string().trim().min(3).max(80),
  assetClass: z.enum(["Equity / xStocks", "RWA Pairs", "AI Agents", "Conviction / Meme"]),
  curve: curveSchema,
  quoteToken: z.enum(["SOL", "USDC", "MET", "JUP", "JupUSD"]),
  initialVirtualQuoteReserve: z.number().finite().positive(),
  initialVirtualBaseReserve: z.number().finite().positive(),
  graduationThreshold: z.number().finite().positive(),
  startFeeBps: z.number().int().min(0).max(9900),
  endFeeBps: z.number().int().min(0).max(9900),
  feeDecaySlots: z.number().int().positive(),
  feeCliffSlots: z.number().int().min(0),
  creatorFeeShareBps: z.number().int().min(0).max(10000),
  partnerFeeShareBps: z.number().int().min(0).max(10000),
  protocolFeeShareBps: z.number().int().min(0).max(10000),
  migrationFeeOption: z.number().int().min(0).max(5),
  lockedLpBps: z.number().int().min(0).max(10000),
  lpVestingDays: z.number().int().min(0).max(3650),
}).superRefine((config, ctx) => {
  if (config.graduationThreshold < QUOTE_TOKENS[config.quoteToken].minThreshold) ctx.addIssue({ code: "custom", path: ["graduationThreshold"], message: `Minimum ${QUOTE_TOKENS[config.quoteToken].minThreshold} ${config.quoteToken}` });
  if (config.endFeeBps > config.startFeeBps) ctx.addIssue({ code: "custom", path: ["endFeeBps"], message: "Steady fee cannot exceed launch fee" });
  if (config.creatorFeeShareBps + config.partnerFeeShareBps + config.protocolFeeShareBps > 10000) ctx.addIssue({ code: "custom", path: ["creatorFeeShareBps"], message: "Fee shares cannot exceed 100%" });
  if (config.feeCliffSlots >= config.feeDecaySlots) ctx.addIssue({ code: "custom", path: ["feeCliffSlots"], message: "Cliff must end before fee decay" });
});
export type DbcConfig = z.infer<typeof configSchema>;

export function toEventConfig(config: DbcConfig) {
  const valid = configSchema.parse(config);
  return {
    schema: "EvtCreateConfigV2",
    programId: DBC_PROGRAM_ID,
    quoteMint: QUOTE_TOKENS[valid.quoteToken].mint,
    curve: valid.curve,
    virtualReserves: { quote: valid.initialVirtualQuoteReserve, base: valid.initialVirtualBaseReserve },
    migration: { quoteThreshold: valid.graduationThreshold, feeConfig: MIGRATION_FEES[valid.migrationFeeOption].key, lockedLpBps: valid.lockedLpBps, vestingDays: valid.lpVestingDays },
    feeSchedule: { startBps: valid.startFeeBps, endBps: valid.endFeeBps, cliffSlots: valid.feeCliffSlots, decaySlots: valid.feeDecaySlots },
    feeSharesBps: { creator: valid.creatorFeeShareBps, partner: valid.partnerFeeShareBps, protocol: valid.protocolFeeShareBps, lp: 10000 - valid.creatorFeeShareBps - valid.partnerFeeShareBps - valid.protocolFeeShareBps },
  };
}
