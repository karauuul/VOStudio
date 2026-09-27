import { describe, expect, it } from 'vitest'
import { acceptedTerm, termFields } from '../src/shared/glossary'
import type { Term } from '../src/shared/domain'

const proposed: Term = { term: 'Old', translation: 'Alt', note: 'n', proposed: true }

describe('acceptedTerm', () => {
  it('accepts the stored term when the draft is unchanged', () => {
    expect(acceptedTerm(proposed, termFields(proposed))).toEqual({ term: 'Old', translation: 'Alt', note: 'n' })
  })

  it('accepts the edited draft in place of the stored term', () => {
    expect(acceptedTerm(proposed, { term: ' New ', translation: 'Neu', note: '' })).toEqual({ term: 'New', translation: 'Neu' })
  })

  it('falls back to the stored term when the draft lost a required field', () => {
    expect(acceptedTerm(proposed, { term: 'New', translation: ' ', note: 'x' })).toEqual({ term: 'Old', translation: 'Alt', note: 'n' })
  })
})
