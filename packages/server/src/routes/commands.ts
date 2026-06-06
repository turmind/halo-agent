import { Hono } from 'hono'
import type { CommandRegistry } from '../commands/registry.js'
import { scanSkillDescriptors } from '../commands/skill-command.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'

export function createCommandRoutes(
  registry: CommandRegistry,
  smRegistry?: SessionManagerRegistry,
) {
  const app = new Hono()

  app.get('/commands', async (c) => {
    const projectId = c.req.query('projectId')
    const sessionId = c.req.query('sessionId')
    const agentId = c.req.query('agentId')

    // Preferred path: sessionId + projectId — only show skills the session's
    // agent is whitelisted for (matches the server-side permission gate in
    // execSkillCommand).
    if (sessionId && projectId && smRegistry) {
      const sm = smRegistry.getOrCreate(projectId)
      const skills = await sm.listAvailableSkillCommands(sessionId)
      const builtins = registry.listDescriptors().filter((d) => d.source !== 'skill')
      return c.json({ commands: [...builtins, ...skills] })
    }

    // Pre-session path: agentId + projectId — the admin chat UI hits this
    // before a session has been opened, so it can show the slash-command
    // popup filtered by the agent the user is about to start with. Same
    // gate logic as the sessionId path, just keyed off agentId directly.
    if (agentId && projectId && smRegistry) {
      const sm = smRegistry.getOrCreate(projectId)
      const skills = await sm.listAvailableSkillCommandsForAgent(agentId)
      const builtins = registry.listDescriptors().filter((d) => d.source !== 'skill')
      return c.json({ commands: [...builtins, ...skills] })
    }

    // Legacy path: only projectId — list every skill in the workspace, no
    // agent-scoped filtering. Kept for clients that don't send sessionId or
    // agentId yet.
    if (projectId) {
      registry.clearSkillCommands()
      const descriptors = await scanSkillDescriptors(projectId)
      for (const desc of descriptors) registry.registerDescriptor(desc)
    }

    return c.json({ commands: registry.listDescriptors() })
  })

  return app
}
