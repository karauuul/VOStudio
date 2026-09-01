import { useEffect, type MutableRefObject } from 'react'

export function useWire<T>(ref: MutableRefObject<T | null>, value: T): void {
  useEffect(() => {
    ref.current = value
    return () => {
      ref.current = null
    }
  }, [ref, value])
}
