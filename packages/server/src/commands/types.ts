export interface CommandDescriptor {
  name: string
  slashName: string
  description: string
  type: 'server' | 'client'
  argHint?: string
  source: 'builtin' | 'skill'
  skillId?: string
  hidden?: boolean
  /** Access-level gate from SKILL.md frontmatter. When set, the
   *  command is only listed (and only callable) when the session's
   *  access level is at least as permissive. */
  requiresAccess?: 'full' | 'workspace' | 'readonly'
}
