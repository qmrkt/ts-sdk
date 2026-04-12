const runtimeChecks = [
  {
    specifier: '@questionmarket/sdk',
    requiredExports: ['sdkVersion', 'calculatePrices', 'quoteBuyForBudgetFromState'],
  },
  {
    specifier: '@questionmarket/sdk/blueprints',
    requiredExports: ['compileResolutionBlueprint', 'validateResolutionBlueprint', 'getResolutionBlueprintPreset'],
  },
  {
    specifier: '@questionmarket/sdk/clients/question-market',
    requiredExports: ['buy', 'getMarketState'],
  },
  {
    specifier: '@questionmarket/sdk/clients/market-factory',
    requiredExports: ['createMarketAtomic', 'minimumBootstrapDeposit'],
  },
  {
    specifier: '@questionmarket/sdk/clients/protocol-config',
    requiredExports: ['readConfig'],
  },
]

for (const check of runtimeChecks) {
  const mod = await import(check.specifier)
  for (const exportName of check.requiredExports) {
    if (!(exportName in mod)) {
      throw new Error(`${check.specifier} is missing export ${exportName}`)
    }
  }
}
