---
name: web-search
description: Real-time web search with two gears. Fast (default, Amazon Nova grounding, ~3s, cheap) — current events, news, prices, any routine lookup. Deep (--deep, OpenAI GPT-5.6 web_search via Bedrock Mantle, ~20-40s, token-expensive) — multi-round retrieval with first-hand sources and per-claim citations, for verifying facts behind important decisions or double-checking weak/contradictory fast results. Default to fast; escalate to deep only when the question deserves depth.
user-invocable: false
---
# Web Search

One skill, two gears:

| Gear | Engine | Speed / cost | Use for |
|---|---|---|---|
| **fast** (default) | Amazon Nova 2 Lite `nova_grounding` | ~3 s, ~500 tokens | News, quotes, prices, routine lookups — the everyday default |
| **deep** (`--deep`) | OpenAI GPT-5.6 `web_search` (Bedrock Mantle) | ~20-40 s, 10-40k tokens | Fact verification before important conclusions; second opinion when fast results look weak, self-contradictory, or conflict with data you hold |

Deep gear does multi-round real retrieval (bilingual query rewriting, `site:`-scoped
searches against official sites), leans toward authoritative first-hand sources
(official announcements, news agencies), and attaches a citation to every claim —
**expensive and slow, but thorough and it doesn't make things up**.

## Usage

```bash
# fast (default) — everyday lookups
python3 ~/.halo/global/skills/web-search/search.py "What are the latest news about the China A-share market today?"

# deep — verify facts that must be right
python3 ~/.halo/global/skills/web-search/search.py --deep "What did the US Federal Reserve announce most recently about interest rates?"
```

- Output: answer text + a `Sources:` URL list (gear/model/token usage on stderr).
- Deep gear default model is `luna` (reasoning effort=max — retrieval planning
  maxed out). `--deep --model sol` is carpet-bombing research (auto-paired with
  effort=xhigh; ~3x more search queries, roughly double the tokens) — reserve it
  for "profile one stock / one topic exhaustively" jobs.
- Full natural-language questions beat keyword stubs in both gears
  (`"RTX 5080"` ✗ → `"Tell me about the NVIDIA RTX 5080, including specs and price."` ✓).
  English works best; Chinese works too — deep gear rewrites queries bilingually.
- Search output is still a lead, not gospel: for critical figures, `web_fetch`
  the cited source URL and confirm before acting on it.
- Auth is automatic in both gears (machine AWS credentials — no API key to
  configure or rotate). Deep gear needs the `aws-bedrock-token-generator` pip
  package (one-time: `pip3 install --user aws-bedrock-token-generator`).
- A deep call can take 40 s — be patient in shell_exec. One clear question per
  call; don't fan out parallel calls.
