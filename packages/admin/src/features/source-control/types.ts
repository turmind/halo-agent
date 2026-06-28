import type { api } from '@/shared/api-client'

/** Working-tree status as returned by `api.git.status`. */
export type GitStatus = Awaited<ReturnType<typeof api.git.status>>
export type GitFileStatus = GitStatus['files'][number]
