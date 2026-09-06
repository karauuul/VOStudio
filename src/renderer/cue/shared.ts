import { estimateStsCredits } from '@shared/domain'

export const credits = (sec: number): string => estimateStsCredits(sec).toLocaleString('en-US')
