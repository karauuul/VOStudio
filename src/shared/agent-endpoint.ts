export const AGENT_TOKEN_FILE = 'agent-token'
export const AGENT_SOCKET_FILE = 'agent.sock'
export const AGENT_FLAG = '--agent'

export function agentEndpoint(platform: string, userData: string, sha256Hex: (text: string) => string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\vostudio-${sha256Hex(userData.toLowerCase()).slice(0, 16)}`
  return `${userData.replace(/\/+$/, '')}/${AGENT_SOCKET_FILE}`
}
