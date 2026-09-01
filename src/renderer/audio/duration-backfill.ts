import type { Take } from '@shared/domain'
import { api } from '../api'
import { DurationQueue } from './duration-queue'

export const durationQueue = new DurationQueue({
  flush: (batch) => api['take:setDurations'](batch),
})

export function reportTakeDuration(cueId: string, take: Take, decoded: number): void {
  if (take.duration > 0) return
  durationQueue.push({ cueId, takeId: take.id, duration: decoded })
}
