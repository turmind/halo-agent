/** A Halo root session id taken from outside (cron jobs, AgentCore
 *  /invocations, the session-dirs notify hand-off) — no `>` sub-session
 *  paths. The charset every channel / cli-minted id already fits, and nothing
 *  that could escape the sessions dir once the id becomes a file name.
 *  No imports: the session-dirs front (node builtins only) uses it too. */
export const ROOT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{1,200}$/
