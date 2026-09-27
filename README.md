# Meteora DBC Studio

Meteora DBC Studio is a local engineering workbench for designing and reviewing Dynamic Bonding Curve launch configurations. I built it to make the launch lifecycle legible as one system: price discovery, launch-time fee protection, graduation, and the liquidity venue that receives the pool afterward. The application produces indicative calculations and SDK-oriented configuration output; it does not submit transactions or replace protocol-side validation.

## Problem and system boundary

A launch configuration couples several decisions that are easy to review in isolation and difficult to reason about together. The virtual reserves and curve shape determine price progression. The graduation threshold decides how much quote liquidity must enter before migration. The slot schedule changes the cost of early trades. Migration fee selection, LP locking, and fee shares shape the destination pool economics.

I use the same active configuration across the four workspace views:

- **Workbench** combines the curve and fee visualizations, editable launch parameters, a slot-based launch replay, a lifecycle view, and an `EvtSwap2` quote simulator. At the graduation boundary, indicative swaps route through a constant-product model for the selected migrated stack and use the selected migration fee tier.
- **Marketplace** filters the built-in launch presets and compares up to three configurations before loading one into the workbench.
- **Inspector** requests account metadata from the Solana mainnet RPC through a Next.js route, and exposes the program, quote mint, and migration fee configuration references used by the UI.
- **SDK Export** renders a TypeScript launch example and the validated `EvtCreateConfigV2` JSON representation of the active configuration.

The preset catalog covers xStocks and other equity launches, RWA pairs, AI agents, and conviction or meme launches. Venue labels such as xStocks Catalog, Ondo RFQ, Backpack Onchain, Jupiter LFG, and Meteora Native are launch metadata. They do not imply a live integration with those venues. Likewise, `Oracle GuardrailBand`, market-open cliff sync, and compounding-fee-share labels describe configuration intent in this prototype; the application does not fetch external oracle or venue state.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/app/studio.tsx` | Client-side workspace, state, charts, controls, quotes, copy and download actions |
| `src/app/globals.css` | Obsidian and ember design tokens, layout, surface treatments, responsive rules, and range input styling |
| `src/lib/protocol.ts` | DBC constants, quote token and migration fee references, Zod schemas, and `EvtCreateConfigV2` serialization |
| `src/lib/presets.ts` | Twelve validated example configurations and their venue and lifecycle metadata |
| `src/lib/simulator.ts` | Curve pricing, fee decay, numerical integration, launch scenario metrics, and swap quote calculations |
| `src/app/api/solana/dbc-status/route.ts` | Server-side `getAccountInfo` proxy with address validation, latency reporting, timeout, and a short program-account cache |
| `src/lib/protocol.test.ts` | Unit coverage for constants, validation, curve and swap math, migration routing, scenarios, and preset integrity |

`configSchema` is the boundary for configuration accepted by the simulator and exporter. It checks field ranges, quote-token-specific minimum graduation thresholds, fee-share totals, fee ordering, and cliff/decay ordering. The UI keeps parameter edits visible while showing validation feedback; the SDK JSON export uses the active configuration when valid and falls back to the selected preset while edits are invalid.

## Mathematical model

### Curve pricing

Let `q` be quote reserve raised so far, `G` the graduation threshold, `Q₀` the initial virtual quote reserve, and `B₀` the initial virtual base reserve. Within the curve, progress is:

```text
p = clamp(q / G, 0, 1)
```

The simulator computes spot price as:

```text
P(q) = ((Q₀ + q)² / (Q₀ × B₀)) × S(p)
```

`S(p)` applies the selected shape multiplier:

| Shape | Multiplier used by the simulator |
| --- | --- |
| Flat | `1 + 0.13p` |
| Exponential | `exp(1.2p)` |
| Long Curve | `1 + 1.2p^2.3` |
| Stepped Institutional | `1 + 0.18 × min(3, floor(4p)) + 0.08 × (p mod 0.25)` |

These are the workbench's explicit illustrative functions, not a claim that they reproduce every on-chain DBC configuration or rounding rule. The displayed implied FDV is the modeled spot price multiplied by the configured initial virtual base reserve.

### Swap amounts and price representation

For DBC buy quotes, `baseForQuote` integrates `1 / P(q)` between the current and resulting quote reserves with 128-segment Simpson integration. Exact-out buys use a binary search over that integral to find the quote input. Sells invert the same modeled relationship to determine the quote output. Fees are applied using the fee for the requested slot, and the resulting trade fee is split between protocol, partner, creator, and LP shares; the LP share is the remainder after configured explicit shares.

The chart displays `sqrtPrice` as the decimal square root of the modeled spot price. A Q64.64 value is a fixed-point encoding of a normalized square-root price: after applying the protocol's token orientation and decimal normalization, the raw fixed-point integer is conceptually `floor(sqrt(normalizedPrice) × 2^64)`. The chart's decimal readout is not a raw on-chain Q64.64 integer, and it must not be copied into an instruction as one.

### Slot fee decay

The configured launch fee remains at `startFeeBps` through `feeCliffSlots`. Between the cliff and `feeDecaySlots`, it decays linearly. At and after `feeDecaySlots`, it remains at `endFeeBps`:

```text
fee(slot) = startFeeBps                                      when slot <= cliff
          = startFeeBps + (endFeeBps - startFeeBps) × t      between cliff and decay
          = endFeeBps                                        when slot >= decay
t = (slot - cliff) / (decay - cliff)
```

The launch replay maps progress to a slot for one of three scenarios. `NYSE / xStocks Bell Open` uses the configured decay window; `Bot Sniper Wave (Slot 0-50)` compresses the replay into the first 50 slots and applies a higher estimated demand multiplier; `Organic Conviction Climb` extends the decay window by 1.35 and applies a lower estimated demand multiplier. Captured LP fee telemetry is an estimate derived from the replay progress, active fee, LP share, and scenario multiplier, not an observed transaction total.

### `EvtSwap2` modes and graduation routing

The quote simulator exposes `Exact-In`, `Exact-Out`, and `Partial-Fill` modes for buys and sells. Before graduation, quotes use the configured bonding curve and fee schedule. A buy whose requested input exceeds remaining curve capacity is capped at the graduation reserve and marked as a partial fill. At the 100% boundary, the quote is routed to the selected post-graduation target and uses the selected DAMM v2 migration fee tier. The receive card identifies this route so the graduation state does not present a zero quote.

For a post-graduation indicative quote, I seed the constant-product approximation with quote reserve `G`, terminal curve price `P(G)`, and base reserve `G / P(G)`. The selected stack name is carried in the quote for display and export. This gives the UI a nonzero terminal-pool quote, but it is not a stateful DAMM v2 or DLMM simulator: it does not model actual migrated balances, DLMM bins, compounding, or on-chain fees beyond the selected migration tier. Before execution, callers must fetch live pool state and use the official SDK/instructions and exact account data.

## Protocol references

The constants below are the references currently embedded in `src/lib/protocol.ts` and shown by the Inspector. They are part of the application configuration, not a substitute for verifying current cluster accounts before a launch.

### DBC program

| Network | Program | Address |
| --- | --- | --- |
| Solana mainnet-beta | Meteora Dynamic Bonding Curve | `dbcij3LWUppWqq96dh6gJWwBifmcgFLSB5D4DuSMaqN` |

### Quote mints and minimum graduation thresholds

| Quote token | Mint | Minimum graduation threshold |
| --- | --- | ---: |
| SOL (Wrapped SOL) | `So11111111111111111111111111111111111111112` | 10 SOL |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 750 USDC |
| MET | `METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL` | 1,500 MET |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | 1,500 JUP |
| JupUSD | `JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD` | 750 JupUSD |

### DAMM v2 migration fee configuration keys

| Option | Migration fee | Config key |
| ---: | ---: | --- |
| Option 0 | 25 bps | `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` |
| Option 1 | 30 bps | `HBxB8Lf14Yj8pqeJ8C4qDb5ryHL7xwpuykz31BLNYr7S` |
| Option 2 | 100 bps | `7v5vBdUQHTNeqk1HnduiXcgbvCyVEZ612HLmYkQoAkik` |
| Option 3 | 200 bps | `EkvP7d5yKxovj884d2DwmBQbrHUWRLGK6bympzrkXGja` |
| Option 4 | 400 bps | `9EZYAJrcqNWNQzP2trzZesP7XKMHA1jEomHzbRsdX8R2` |
| Option 5 | 600 bps | `8cdKo87jZU2R12KY1BUjjRPwyjgdNjLGqSGQyrDshhud` |

## Local development

Use a Node.js release supported by the installed Next.js version and npm. From the repository root:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The Inspector defaults to the Solana mainnet-beta JSON-RPC endpoint. To use a different RPC provider, set `SOLANA_RPC_URL` in a local `.env.local` file. The endpoint is contacted server-side by the status route; no RPC credentials are required for the public default.

The SDK export view is a code/configuration aid. Its example intentionally requires a wallet and live account inputs supplied by the integrating application. This project does not bundle a wallet adapter or sign transactions.

## Verification

Run the project checks from the repository root:

```bash
npm test
npm run lint
npm run build
```

The test suite covers schema constraints, the quote token and migration fee tables, curve and fee calculations, DBC swap behavior, migrated-pool quoting, launch scenario metrics, and the preset catalog. A passing production build verifies the Next.js App Router application compiles; it does not validate RPC availability or execute an on-chain launch.
