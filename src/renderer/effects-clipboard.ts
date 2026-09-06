import { sanitizeEffects, type ClipEffects } from '@shared/effects'

let box: { fx: ClipEffects | undefined } | null = null

export function copyEffects(fx: ClipEffects | undefined): void {
  box = { fx: sanitizeEffects(fx) }
}

export function copiedEffects(): ClipEffects | undefined {
  return box?.fx
}

export function hasCopiedEffects(): boolean {
  return box !== null
}
