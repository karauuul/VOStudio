import { create } from 'zustand'
import type { TextDraft } from '@shared/text-draft'

export const useTextDraft = create<{ draft: TextDraft | null }>(() => ({ draft: null }))
