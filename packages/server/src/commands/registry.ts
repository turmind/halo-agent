import type { CommandDescriptor } from './types.js'

export class CommandRegistry {
  private descriptors = new Map<string, CommandDescriptor>()

  registerDescriptor(desc: CommandDescriptor): void {
    this.descriptors.set(desc.name, desc)
  }

  listDescriptors(): CommandDescriptor[] {
    return Array.from(this.descriptors.values())
      .filter((d) => !d.hidden)
  }

  clearSkillCommands(): void {
    for (const [name, desc] of this.descriptors) {
      if (desc.source === 'skill') this.descriptors.delete(name)
    }
  }
}
