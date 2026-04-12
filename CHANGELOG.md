# Changelog

## 0.1.0 (2026-04-11)

Initial public release.

- LMSR fixed-point math matching the AVM contract implementation (exp, ln, logSumExp, cost, prices)
- Trade quoting: `quoteBuyForBudgetFromState`, `quoteBuyForSharesFromState`, `calculateSellReturn`
- AVM-safe trade validation: `calculateAvmBuyCost`, `isAvmBuySafe`
- Liquidity scaling for LP deposit/withdraw: `calculateLiquidityScaling`, `calculateLiquidityValue`
- Contract clients: market factory, question market, market schema, protocol config
- Resolution blueprint toolkit: compiler, validator, presets, types, cycle detection, capabilities
- 45 unit tests across LMSR math, blueprint validation, cycle detection, and capabilities
