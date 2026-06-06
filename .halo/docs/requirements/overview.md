# Product Overview

> "Tiangong Kaiwu" — throw in an idea, the agents build it.
> Halo = the international spelling of "Kaiwu"; "halo" in Finnish hints at a spring source.

## One-liner

**Halo is a multi-agent collaborative workspace. The user drives the entire delivery of complex projects through natural language.**

## Problems it solves

### 1. Multi-agent collaboration is opaque to users

Cursor / Claude Code / Devin are developer tools at heart — users have to configure agents, manage context, wire up workflows. Halo hides the orchestration: users just chat; the main agent decides how to split up work.

> Halo is a **self-orchestrating harness** wrapped in a human-readable workspace.

### 2. Agent work products get lost

Existing memory systems are patchwork — MEMORY.md is manual notes, vector search is semantic crumbs. An agent makes a slide deck and remembers "I made a slide deck", but the design thinking, iterations, reasoning chain are gone.

Halo's answer: **everything lives in the workspace. Knowledge is tied to the project, not the agent.**

## Role model

```
             User
              |  natural language
              v
     +------------------+
     |  Main Agent       |
     |  (Orchestrator)   |
     |  Understands intent,
     |  decomposes tasks,
     |  creates/schedules sub-agents,
     |  escalates key decisions
     +---+------+------+-+
         |      |      |
         v      v      v
      Sub-A  Sub-B  Sub-C
      (each with its own tools + skills)
```

**The main agent is a proposer, not a dictator.** It lays out the plan, the user asks "why", adjusts, confirms, and only then does it execute. The user can pause, revert, or redirect at any step.

## Core principles

1. **Thinking is visible** — the user sees task breakdowns, progress, file changes, tool calls. Not a black box.
2. **User in the loop** — the user always has veto power. Any step can be paused, modified, or rejected.
3. **Structured workspace** — all knowledge, decisions, rejected alternatives, and intermediate state are saved as project files. Agents don't need "memory" — they have archives.
4. **Progressive autonomy** — v1: every step needs the human. v2: user-defined autonomy scope. v3: the agent decides what to ask and what to just do.

## Competitive comparison

| Dimension | Cursor / Claude Code | Devin | MetaGPT | Manus | **Halo** |
|---|---|---|---|---|---|
| Target user | Developers | Developers | Developers | General | **Anyone** |
| Agent count | 1 | 1 | Multiple (preset) | 1 | **1 main + N sub** |
| Orchestration | Manual | Black-box | Pipeline | Black-box | **Self-orchestrating + user override** |
| Process visibility | Low | Low | None | Low | **High (the key differentiator)** |
| Mid-run intervention | Yes | No | No | Limited | **Yes** |
| Project memory | Limited | Limited | None | None | **Structured workspace** |
