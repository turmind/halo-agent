export interface WebAccount {
  accountId: string
  token: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly'
  language: string
  createdAt: number
  updatedAt: number
}
