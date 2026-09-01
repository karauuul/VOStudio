import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'

const secretsPath = () => path.join(app.getPath('userData'), 'secrets.bin')

export async function setApiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage is not available')
  const enc = safeStorage.encryptString(key)
  await fs.writeFile(secretsPath(), enc)
}

export async function getApiKey(): Promise<string | null> {
  try {
    const buf = await fs.readFile(secretsPath())
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null
}
