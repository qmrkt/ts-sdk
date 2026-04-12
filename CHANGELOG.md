# Changelog

## 0.1.0 (2026-04-11)

Initial public release.

- LMSR fixed-point math matching the AVM contract implementation (exp, ln, logSumExp, cost, prices)
- Trade quoting: `quoteBuyForBudgetFromState`, `quoteBuyForSharesFromState`, `calculateSellReturn`
- AVM-safe trade validation: `calculateAvmBuyCost`, `isAvmBuySafe`
- Liquidity scaling for LP deposit/withdraw: `calculateLiquidityScaling`, `calculateLiquidityValue`
- Contract clients: market factory, question market (trading, liquidity, resolution), market schema, protocol config
- Resolution blueprint toolkit: compiler, validator, presets, types, cycle detection, capabilities
- Shared utilities in base: `ceilDiv`, `withMinFlatFee`, `withExplicitFlatFee`, `textEncoder`
- Parallel network calls in buy/sell/claim/refund for lower trade latency
- Question-market split into sub-modules: trading, liquidity, resolution, internal
- Removed deprecated `proposalBond`, `creator`, and `registerOutcomeAsa`
- 90 unit tests
