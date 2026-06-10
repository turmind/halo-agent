export interface CommandDescriptor {
  name: string
  slashName: string
  description: string
  type: 'server' | 'client'
  argHint?: string
  source: 'builtin' | 'skill'
  skillId?: string
  hidden?: boolean
  /** Declared sub-actions of an object command (Halo `verbs:` extension).
   *  Drives the noun-verb router (which verbs run builtin vs. fall through to
   *  the skill) and `/cmd help`. Absent on standard skills / flat commands. */
  verbs?: Array<{ name: string; builtin?: boolean; desc?: string; requiresAccess?: 'full' | 'workspace' | 'readonly' }>
  /** Access-level gate from SKILL.md frontmatter. When set, the
   *  command is only listed (and only callable) when the session's
   *  access level is at least as permissive. */
  requiresAccess?: 'full' | 'workspace' | 'readonly'
}
