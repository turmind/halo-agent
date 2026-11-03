import type { IDisposable } from '@xterm/xterm'

/** Minimal stand-ins for the VS Code base `Emitter` / `Disposable` the
 *  ported type-ahead addon was written against. */

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>()

  readonly event = (listener: (value: T) => void): IDisposable => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

export abstract class Disposable implements IDisposable {
  private readonly disposables: IDisposable[] = []

  protected _register<T extends IDisposable>(d: T): T {
    this.disposables.push(d)
    return d
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}
