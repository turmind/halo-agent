export interface TelegramAccount {
  accountId: string
  botToken: string
  botUsername: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly'
  allowedUsers: string
  language: string
  createdAt: number
  updatedAt: number
}
