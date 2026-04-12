const runtimeChecks = [
  {
    specifier: '@question/sdk',
    requiredExports: ['sdkVersion', 'calculatePrices', 'quoteBuyForBudgetFromState'],
  },
  {
    specifier: '@question/sdk/blueprints',
    requiredExports: ['compileResolutionBlueprint', 'validateResolutionBlueprint', 'getResolutionBlueprintPreset'],
  },
  {
    specifier: '@question/sdk/clients/question-market',
    requiredExports: ['buy', 'getMarketState'],
  },
  {
    specifier: '@question/sdk/clients/market-factory',
    requiredExports: ['createMarketAtomic', 'minimumBootstrapDeposit'],
  },
  {
    specifier: '@question/sdk/clients/protocol-config',
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
