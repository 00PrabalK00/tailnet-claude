export type ChatMessage = { role: 'user' | 'assistant'; text: string }
export type RemoteSession = {
  name: string
  cwd: string
  url?: string
  lines: string[]
  chat: ChatMessage[]
}
export type HostReport = {
  host: string
  ok: boolean
  error?: string
  sessions: RemoteSession[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'tailnet-sessions': {
      hosts: Shaped<HostReport[]>
      selected: Shaped<string>
    }
  }
}
