import { useLayoutEffect, type MutableRefObject } from 'react'

export function useWire<T>(ref: MutableRefObject<T | null>, value: T): void {
  useLayoutEffect(() => {
    ref.current = value
    return () => {
      ref.current = null
    }
  }, [ref, value])
}
