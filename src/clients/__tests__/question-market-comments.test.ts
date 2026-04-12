import { describe, expect, it } from 'vitest'

import { planCommentGroup } from '../question-market'

describe('question-market comment planning', () => {
  it('uses a single transaction when all comment boxes fit on the method call', () => {
    expect(planCommentGroup(0)).toEqual({
      methodBoxCount: 0,
      noopBoxCounts: [],
      totalTxnCount: 1,
    })
    expect(planCommentGroup(2)).toEqual({
      methodBoxCount: 2,
      noopBoxCounts: [],
      totalTxnCount: 1,
    })
    expect(planCommentGroup(8)).toEqual({
      methodBoxCount: 8,
      noopBoxCounts: [],
      totalTxnCount: 1,
    })
  })

  it('adds only the minimum shared-resource noop calls once boxes exceed a single transaction', () => {
    expect(planCommentGroup(9)).toEqual({
      methodBoxCount: 8,
      noopBoxCounts: [1],
      totalTxnCount: 2,
    })
    expect(planCommentGroup(16)).toEqual({
      methodBoxCount: 8,
      noopBoxCounts: [8],
      totalTxnCount: 2,
    })
    expect(planCommentGroup(17)).toEqual({
      methodBoxCount: 8,
      noopBoxCounts: [8, 1],
      totalTxnCount: 3,
    })
  })
})
