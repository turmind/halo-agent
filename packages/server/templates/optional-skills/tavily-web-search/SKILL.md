---
name: Tavily Web Search
description: Real-time web search using Tavily Search API. Use this skill when the user asks about current events, news, latest updates, prices, or any real-time information that requires up-to-date web results.
---

# Tavily Web Search

Perform real-time web search via [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search). Returns structured results with content snippets and source URLs.

## How to Use

Call `shell_exec` with the command below. Only change the query string in `-d`; keep `{{params.api_key}}` exactly as-is (the system substitutes it at runtime).

```bash
curl -s -X POST https://api.tavily.com/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {{params.api_key}}" \
  -d '{"query":"your natural language query here","max_results":5,"include_answer":true}' \
  | python3 -c "
import sys,json
r=json.load(sys.stdin)
if r.get('answer'): print('Answer:',r['answer'],'\n')
for x in r.get('results',[]):
    print(f\"- [{x['title']}]({x['url']})\")
    print(f\"  {x['content'][:300]}\n\")
"
```

For news queries, add `"topic":"news"` to `-d`. For deeper search, use `"search_depth":"advanced"` (costs 2 credits instead of 1).

## Query Formulation

Use **natural language questions**.

### Language choice — important

Tavily's index is dominated by English-language sources for international topics. Pick the query language by topic, not by the user's input language:

| Topic | Use English query | Use Chinese query |
|---|---|---|
| International sports / celebrities (e.g. Lionel Messi, Taylor Swift) | ✅ | ❌ Chinese hits niche aggregators only |
| International tech / products / pricing (e.g. iPhone, RTX 5080) | ✅ | ❌ |
| Global news / politics / finance | ✅ (or both) | Often weak |
| Domestic Chinese topics (A 股, 国内政策, 中文媒体) | ❌ | ✅ |
| Chinese tech ecosystem (e.g. 字节跳动, 小米) | Either | ✅ |

If the user asks in Chinese about an international topic, **translate the entity to its English form first**: 「梅西最新消息」→ `"Lionel Messi latest news"`. Don't pass `"梅西最新消息"` directly to the API for non-Chinese topics — you'll mostly miss ESPN / Bleacher Report / Reuters etc.

### Time-sensitive queries: prefer `time_range`, not year keywords

Don't bake the year into the query string. Two reasons:
1. You may be wrong about the current year. (The skill itself doesn't see today's date.)
2. The index is fresher than your knowledge cutoff — pinning a year filters out the most relevant recent results.

**Use `time_range` instead**: add `"time_range":"day" | "week" | "month" | "year"` to `-d`. For breaking news, `"week"` is usually right; for a monthly review, `"month"`.

If the user explicitly anchors to a past year ("how was Apple's 2023?"), then a year keyword is correct.

### Templates

| User Intent | Query template |
|---|---|
| Latest news on a person/product | `"<English entity name> latest news"` + `time_range: "week"` |
| Current product/pricing/specs | `"Tell me about <X>, including specs, price, and latest updates."` |
| Domestic Chinese news | `"<中文实体> 最新动态"` + `time_range: "week"` |
| General reference question | `"Search for information about X."` |

**Examples**:
- ✅ `"Lionel Messi latest news"` + `time_range: "week"`
- ✅ `"梅西最新动态"` (only if specifically targeting Chinese-language sources)
- ❌ `"梅西最新新闻 2025"` — wrong language for international topic *and* hard-coded year
- ❌ `"Messi news"` — too terse, no recency hint

## Optional Parameters

Add these fields to the JSON body as needed:

| Parameter | Default | Description |
|---|---|---|
| `max_results` | 5 | Number of results (1–20) |
| `include_answer` | false | AI-generated summary answer (`true`, `"basic"`, or `"advanced"`) |
| `search_depth` | `"basic"` | `"basic"` / `"advanced"` (2 credits, higher relevance) |
| `topic` | `"general"` | `"news"` for time-sensitive queries |
| `time_range` | null | `"day"`, `"week"`, `"month"`, `"year"` |
| `include_raw_content` | false | Full page content (`true`, `"markdown"`, `"text"`) |
| `include_domains` | [] | Restrict to specific domains |
| `exclude_domains` | [] | Exclude specific domains |

## Requirements

- API key configured at `tavily-web-search.params.api_key` in `~/.halo/secrets/settings.yaml`, or set env var `TAVILY_API_KEY`. Set it from the Settings page → Skills → Tavily Web Search.
