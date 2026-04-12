import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const marketFactorySpec = require('./specs/MarketFactory.arc56.json')
export const protocolConfigSpec = require('./specs/ProtocolConfig.arc56.json')
export const questionMarketSpec = require('./specs/QuestionMarket.arc56.json')
