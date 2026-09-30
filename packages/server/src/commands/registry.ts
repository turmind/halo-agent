import type { CommandDescriptor } from './types.js'

export class CommandRegistry {
  private descriptors = new Map<string, CommandDescriptor>()

  registerDescriptor(desc: CommandDescriptor): void {
    this.descriptors.set(desc.name, desc)
  }

  listDescriptors(opts?: { includeHidden?: boolean }): CommandDescriptor[] {
    return Array.from(this.descriptors.values())
      .filter((d) => opts?.includeHidden || !d.hidden)
  }

  /** Startup integrity checks include hidden commands: visibility is not routing. */
  assertDispatchCommands(commands: readonly string[]): void {
    const builtins = this.listDescriptors({ includeHidden: true }).filter((d) => d.source === 'builtin')
    const declared = new Set(builtins.map((d) => d.slashName))
    const dispatched = new Set(commands)
    const declaredServer = new Set(builtins.filter((d) => d.type === 'server').map((d) => d.slashName))
    const missingDispatch = [...declaredServer].filter((n) => !dispatched.has(n))
    const orphanDispatch = [...dispatched].filter((n) => !declared.has(n))
    if (missingDispatch.length > 0) {
      throw new Error(
        `[Server] Command descriptors without a dispatch case: ${missingDispatch.join(', ')}. ` +
        `Either add a case in channels/shared/commands.ts dispatchCommand or change the descriptor type to 'client'.`,
      )
    }
    if (orphanDispatch.length > 0) {
      throw new Error(
        `[Server] Dispatch cases without a descriptor: ${orphanDispatch.join(', ')}. ` +
        `Add a registerDescriptor entry in commands/index.ts or remove the dispatch case.`,
      )
    }
  }
}
