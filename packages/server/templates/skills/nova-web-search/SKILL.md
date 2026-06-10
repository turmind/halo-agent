---
name: nova-web-search
description: Real-time web search using Amazon Nova 2 Lite's built-in nova_grounding system tool. Use this skill when the user asks about current events, news, latest updates, prices, or any real-time information. This replaces the web_search tool.
user-invocable: false
---
# Nova Web Search

Perform real-time web search using Amazon Nova 2 Lite's built-in `nova_grounding` system tool. Returns a synthesized answer with source URLs.

## How to Use

Run the following Python script via `shell_exec`:

```python
import boto3
from botocore.config import Config

bedrock = boto3.client("bedrock-runtime", region_name="us-east-1", config=Config(read_timeout=60))

query = "YOUR_QUERY_HERE"  # Replace with the actual search query

response = bedrock.converse(
    modelId="us.amazon.nova-2-lite-v1:0",
    messages=[{"role": "user", "content": [{"text": query}]}],
    toolConfig={"tools": [{"systemTool": {"name": "nova_grounding"}}]}
)

answer = ""
sources = []
for content in response["output"]["message"]["content"]:
    if "text" in content:
        answer += content["text"]
    elif "citationsContent" in content:
        for c in content["citationsContent"].get("citations", []):
            url = c.get("location", {}).get("web", {}).get("url", "")
            if url and url not in sources:
                sources.append(url)

print(answer)
if sources:
    print("\nSources:", sources)
```

## Query Formulation

Nova grounds better against full natural-language questions than against
keyword stubs — raw keywords return more loosely-related sources, while
a question gives Nova enough context to filter.

| User Intent | Query Template |
|---|---|
| News / updates / latest developments | `"What are the latest news about X?"` |
| Product / specs / concept lookup | `"Tell me about X, including specs, price, and latest updates."` |
| General search | `"Search for information about X."` |

**Examples:**
- ✅ `"What are the latest news about the Middle East conflict?"`
- ✅ `"Tell me about the NVIDIA RTX 5080, including specs and price."`
- ✗ `"RTX 5080"` — terse keywords leave Nova guessing at intent

## Requirements

- Region **must** be `us-east-1`
- English queries yield better results than other languages
- Model ID: `us.amazon.nova-2-lite-v1:0`
