---
name: web-search
description: Real-time web search on AWS Bedrock (needs AWS credentials with Bedrock access) with two gears. Fast (default, Amazon Nova grounding, ~3s, cheap) — current events, news, prices, any routine lookup. Deep (--deep, OpenAI GPT-5.6 web_search via Bedrock Mantle, ~20-40s, token-expensive) — multi-round retrieval with first-hand sources and per-claim citations, for verifying facts behind important decisions or double-checking weak/contradictory fast results. Default to fast; escalate to deep only when the question deserves depth. For AWS documentation, service announcements or regional availability, use the aws-knowledge skill instead.
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

Use `<workspace>/.halo/skills/web-search/search.py` if that exists, else
`~/.halo/global/skills/web-search/search.py`.

Always prefix the call with the two region variables, keeping
`{{params.fast_region}}` / `{{params.deep_region}}` exactly as written (the
system substitutes them at runtime; unset = built-in defaults):

```bash
# fast (default) — everyday lookups
WEB_SEARCH_FAST_REGION='{{params.fast_region}}' WEB_SEARCH_DEEP_REGION='{{params.deep_region}}' \
  python3 ~/.halo/global/skills/web-search/search.py "What are the latest news about the China A-share market today?"

# deep — verify facts that must be right
WEB_SEARCH_FAST_REGION='{{params.fast_region}}' WEB_SEARCH_DEEP_REGION='{{params.deep_region}}' \
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
- Both gears run on AWS Bedrock with the machine's AWS credentials (no API key):
  fast = Amazon Nova 2 Lite + web grounding (`bedrock:InvokeModel` +
  `bedrock:InvokeTool` on `amazon.nova_grounding`, US regions only); deep =
  OpenAI GPT-5.6 on Bedrock Mantle (`bedrock-mantle:CreateInference` +
  `bedrock-mantle:CallWithBearerToken`). Deep gear needs the
  `aws-bedrock-token-generator` pip package (one-time:
  `pip3 install --user aws-bedrock-token-generator`). An AccessDenied /
  credentials error means this machine lacks that access — say so, don't retry.
- Regions are set in Settings → Skills → web-search (`fast_region` default
  us-east-1; `deep_region` default us-west-2 for luna, us-east-1 for sol — sol
  isn't offered in us-west-2).
- A deep call can take 40 s — be patient in shell_exec. One clear question per
  call; don't fan out parallel calls.
