/**
 * Path constants & builders for Halo's on-disk layout.
 *
 * One source of truth for every `.halo/...` directory and file. The
 * project's storage layout is described in
 * `.halo/docs/design/storage.md`; if that doc moves, only this file
 * has to follow.
 *
 * Keep this file thin: pure path math, no fs side-effects (no mkdir,
 * no read/write). Modules that need to ensure a dir exists call
 * `fs.mkdirSync` themselves after asking for the path here. That keeps
 * import-time effects out and makes these helpers safe to use anywhere.
 *
 * Two scopes of path:
 *   - **workspace-scoped** (`<ws>/.halo/...`): per-project state
 *     (sessions, db, evo runs, channels)
 *   - **global** (`~/.halo/global/...` or `~/.halo/secrets/...`):
 *     cross-workspace state (settings, secrets, internal-agent
 *     sessions, evo / cron daemon dbs)
 */
import path from 'node:path'
import { homedir } from 'node:os'

// ── Root anchors ─────────────────────────────────────────────────────

/** `~/.halo` — user-level Halo home. */
export function haloHome(): string {
  return path.join(homedir(), '.halo')
}

/** `~/.halo/global` — platform-owned files (templates, prompts, skills,
 *  internal-agent sessions, cron / evo dbs). */
export function globalDir(): string {
  return path.join(haloHome(), 'global')
}

/** `~/.halo/secrets` — credentials only (config.yaml, settings.yaml,
 *  channels.db). 0700 perms recommended. */
export function secretsDir(): string {
  return path.join(haloHome(), 'secrets')
}

// ── Per-workspace `<ws>/.halo/...` paths ───────────────────────────

/** `<ws>/.halo` — the workspace's halo dir. */
export function wsHaloDir(workspacePath: string): string {
  return path.join(workspacePath, '.halo')
}

/** `<ws>/.halo/INSTRUCTIONS.md`. */
export function wsInstructions(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'INSTRUCTIONS.md')
}

/** `<ws>/.halo/USER.md`. */
export function wsUserMd(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'USER.md')
}

/** `<ws>/.halo/INDEX.md`. */
export function wsIndexMd(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'INDEX.md')
}

/** `<ws>/.halo/agents` directory. */
export function wsAgentsDir(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'agents')
}

/** `<ws>/.halo/agents/<id>` directory for a specific agent. */
export function wsAgentDir(workspacePath: string, agentId: string): string {
  return path.join(wsAgentsDir(workspacePath), agentId)
}

/** `<ws>/.halo/skills` directory. */
export function wsSkillsDir(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'skills')
}

/** `<ws>/.halo/skills/<id>` directory for a specific skill. */
export function wsSkillDir(workspacePath: string, skillId: string): string {
  return path.join(wsSkillsDir(workspacePath), skillId)
}

/** `<ws>/.halo/sessions` — per-agent session JSON dir root. */
export function wsSessionsDir(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'sessions')
}

/** `<ws>/.halo/halo.db` — per-workspace sqlite db (sessions,
 *  command registry, etc.). */
export function wsDbPath(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'halo.db')
}

/** `<ws>/.halo/settings.yaml` — workspace overrides for global settings. */
export function wsSettingsYaml(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'settings.yaml')
}

// ── Evolution paths ──────────────────────────────────────────────────

/** `<ws>/.halo/evo` — evolution state root. */
export function wsEvoDir(workspacePath: string): string {
  return path.join(wsHaloDir(workspacePath), 'evo')
}

/** `<ws>/.halo/evo/runs/<id>` — per-evolution-run artifact dir. */
export function wsEvoRunDir(workspacePath: string, runId: string): string {
  return path.join(wsEvoDir(workspacePath), 'runs', runId)
}

/** `<ws>/.halo/evo/runs/<id>/sandbox` — per-run sandbox (drafter +
 *  scorer + apply all run against this). */
export function wsEvoSandboxDir(workspacePath: string, runId: string): string {
  return path.join(wsEvoRunDir(workspacePath, runId), 'sandbox')
}

/** `<ws>/.halo/evo/applies/<id>` — per-apply artifact dir. */
export function wsEvoApplyDir(workspacePath: string, applyId: string): string {
  return path.join(wsEvoDir(workspacePath), 'applies', applyId)
}

/** `<ws>/.halo/evo/archive` — zipped runs / applies past retention. */
export function wsEvoArchiveDir(workspacePath: string): string {
  return path.join(wsEvoDir(workspacePath), 'archive')
}

/** `<ws>/.halo/evo/archive/run-<id>.zip`. */
export function wsEvoArchivedRunZip(workspacePath: string, runId: string): string {
  return path.join(wsEvoArchiveDir(workspacePath), `run-${runId}.zip`)
}

/** `<ws>/.halo/evo/archive/apply-<id>.zip`. */
export function wsEvoArchivedApplyZip(workspacePath: string, applyId: string): string {
  return path.join(wsEvoArchiveDir(workspacePath), `apply-${applyId}.zip`)
}

/** `<ws>/.halo/evo/history/apply-<id>` — pre-apply rollback snapshot. */
export function wsEvoHistoryDir(workspacePath: string, applyId: string): string {
  return path.join(wsEvoDir(workspacePath), 'history', `apply-${applyId}`)
}

// ── Global paths ─────────────────────────────────────────────────────

/** `~/.halo/global/internal-sessions` — root for `__*__` agent
 *  session files (evo, score, apply). */
export function globalInternalSessionsDir(): string {
  return path.join(globalDir(), 'internal-sessions')
}

/** `~/.halo/global/internal-sessions/<agentId>` — one internal agent's
 *  session dir. */
export function globalInternalSessionDirFor(agentId: string): string {
  return path.join(globalInternalSessionsDir(), agentId)
}

/** `~/.halo/global/internal-sessions/<agentId>/<seg>.json` — a single
 *  internal-agent session file. */
export function globalInternalSessionFile(agentId: string, fileSegmentName: string): string {
  return path.join(globalInternalSessionDirFor(agentId), `${fileSegmentName}.json`)
}

/** `~/.halo/global/agents` — global agent definitions. */
export function globalAgentsDir(): string {
  return path.join(globalDir(), 'agents')
}

/** `~/.halo/global/agents/<id>`. */
export function globalAgentDir(agentId: string): string {
  return path.join(globalAgentsDir(), agentId)
}

/** `~/.halo/global/skills`. */
export function globalSkillsDir(): string {
  return path.join(globalDir(), 'skills')
}

/** `~/.halo/global/skills/<id>`. */
export function globalSkillDir(skillId: string): string {
  return path.join(globalSkillsDir(), skillId)
}

/** `~/.halo/global/prompts`. */
export function globalPromptsDir(): string {
  return path.join(globalDir(), 'prompts')
}

/** `~/.halo/global/models`. */
export function globalModelsDir(): string {
  return path.join(globalDir(), 'models')
}

/** `~/.halo/global/builtin` — server self-knowledge docs. */
export function globalBuiltinDir(): string {
  return path.join(globalDir(), 'builtin')
}

/** `~/.halo/global/INSTRUCTIONS.md`. */
export function globalInstructions(): string {
  return path.join(globalDir(), 'INSTRUCTIONS.md')
}

/** `~/.halo/global/USER.md`. */
export function globalUserMd(): string {
  return path.join(globalDir(), 'USER.md')
}

/** `~/.halo/global/logs` — root for daemon logs. */
export function globalLogsDir(): string {
  return path.join(globalDir(), 'logs')
}

/** `~/.halo/global/logs/cron` — per-cron-run cli stdout/stderr. */
export function cronLogsDir(): string {
  return path.join(globalLogsDir(), 'cron')
}

/** `~/.halo/global/logs/cron/<runId>.log`. */
export function cronLogFile(runId: string): string {
  return path.join(cronLogsDir(), `${runId}.log`)
}

/** `~/.halo/global/logs/evo` — per-evo-run wrapper log. */
export function evoLogsDir(): string {
  return path.join(globalLogsDir(), 'evo')
}

/** `~/.halo/global/logs/evo/run-<id>.log`. */
export function evoWrapperLogFile(runId: string): string {
  return path.join(evoLogsDir(), `run-${runId}.log`)
}

/** `~/.halo/global/logs/evo/apply-<id>.log`. */
export function evoApplyLogFile(applyId: string): string {
  return path.join(evoLogsDir(), `apply-${applyId}.log`)
}

// ── Secrets paths ────────────────────────────────────────────────────

/** `~/.halo/secrets/config.yaml`. */
export function secretsConfigYaml(): string {
  return path.join(secretsDir(), 'config.yaml')
}

/** `~/.halo/secrets/settings.yaml`. */
export function secretsSettingsYaml(): string {
  return path.join(secretsDir(), 'settings.yaml')
}

/** `~/.halo/secrets/channels` — per-channel credentials store. */
export function secretsChannelsDir(): string {
  return path.join(secretsDir(), 'channels')
}
