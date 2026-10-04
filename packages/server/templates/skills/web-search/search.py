#!/usr/bin/env python3
"""Web search with two gears.

fast (default): Amazon Nova 2 Lite + nova_grounding — ~3 s, ~500 tokens.
deep (--deep):  OpenAI GPT-5.6 on Bedrock Mantle + server-side web_search —
                multi-round retrieval, first-hand sources, ~20-40 s, 10-40k tokens.

Usage:
  python3 search.py "your question"
  python3 search.py --deep "your question" [--model sol|luna]

Auth is automatic in both gears (machine AWS credentials): fast uses boto3's
default credential chain; deep mints a 12-hour bearer token on every call via
aws-bedrock-token-generator — no API key to configure or rotate.

Regions: WEB_SEARCH_FAST_REGION / WEB_SEARCH_DEEP_REGION override the defaults
below (the skill passes its fast_region / deep_region params through them).
"""
import json
import os
import sys
import urllib.error
import urllib.request

MODELS = {"luna": "openai.gpt-5.6-luna", "sol": "openai.gpt-5.6-sol"}
# Nova web grounding is US-only; us-east-1 / us-east-2 / us-west-2 all verified.
FAST_REGION = "us-east-1"
# bedrock-mantle: Luna is in us-east-1 / us-east-2 / us-west-2, Sol only in
# us-east-1 / us-east-2. us-west-2 answered 3-8x faster than us-east-1 in
# 2026-10-04 tests, so Luna defaults there; Sol takes us-east-1.
DEEP_REGION = {"openai.gpt-5.6-luna": "us-west-2", "openai.gpt-5.6-sol": "us-east-1"}
# luna (default) runs effort=max to squeeze out its retrieval planning; sol's
# retrieval is already exhaustive at medium (measured 48 search queries on one
# question), so it gets xhigh to avoid pointless token doubling — max over
# xhigh measured only ~6% more reasoning tokens.
EFFORTS = {"openai.gpt-5.6-luna": "max", "openai.gpt-5.6-sol": "xhigh"}
SOL_REGIONS = ("us-east-1", "us-east-2")


def env_region(name: str) -> str:
    """Region from env; empty or an unsubstituted `{{…}}` skill-param placeholder = unset."""
    v = os.environ.get(name, "").strip()
    return "" if v.startswith("{{") else v


def fast_search(question: str) -> None:
    import boto3
    from botocore.config import Config

    region = env_region("WEB_SEARCH_FAST_REGION") or FAST_REGION
    bedrock = boto3.client(
        "bedrock-runtime", region_name=region, config=Config(read_timeout=60)
    )
    response = bedrock.converse(
        modelId="us.amazon.nova-2-lite-v1:0",
        messages=[{"role": "user", "content": [{"text": question}]}],
        toolConfig={"tools": [{"systemTool": {"name": "nova_grounding"}}]},
    )
    answer = ""
    sources: list[str] = []
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
        print("\nSources:")
        for u in sources:
            print(" -", u)
    usage = response.get("usage", {})
    print(f"\n[gear=fast model=nova-2-lite region={region} total_tokens={usage.get('totalTokens')}]", file=sys.stderr)


def deep_search(question: str, model: str) -> None:
    from aws_bedrock_token_generator import provide_token

    region = env_region("WEB_SEARCH_DEEP_REGION") or DEEP_REGION[model]
    if model == MODELS["sol"] and region not in SOL_REGIONS:
        print(f"[sol is not offered in {region}; using {DEEP_REGION[model]}]", file=sys.stderr)
        region = DEEP_REGION[model]
    token = provide_token(region=region)
    body = json.dumps(
        {
            "model": model,
            "input": question,
            "tools": [{"type": "web_search"}],
            "reasoning": {"effort": EFFORTS[model]},
        }
    ).encode()
    req = urllib.request.Request(
        f"https://bedrock-mantle.{region}.api.aws/openai/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode(errors='replace')[:2000]}", file=sys.stderr)
        sys.exit(1)

    texts: list[str] = []
    sources: list[str] = []
    for item in data.get("output", []):
        if item.get("type") == "message":
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    texts.append(c.get("text", ""))
                    for a in c.get("annotations", []):
                        if a.get("type") == "url_citation":
                            u = a.get("url", "")
                            if u and u not in sources:
                                sources.append(u)
    print("\n".join(texts))
    if sources:
        print("\nSources:")
        for u in sources:
            print(" -", u)
    usage = data.get("usage", {})
    print(f"\n[gear=deep model={model} region={region} total_tokens={usage.get('total_tokens')}]", file=sys.stderr)


def main() -> None:
    args = sys.argv[1:]
    deep = False
    model = MODELS["luna"]
    if "--deep" in args:
        deep = True
        args.remove("--deep")
    if "--model" in args:
        i = args.index("--model")
        try:
            model = MODELS[args[i + 1]]
        except (IndexError, KeyError):
            print("--model must be 'luna' or 'sol'", file=sys.stderr)
            sys.exit(2)
        del args[i : i + 2]
        if not deep:
            print("--model only applies with --deep", file=sys.stderr)
            sys.exit(2)
    if not args:
        print('usage: search.py [--deep] "<question>" [--model sol|luna]', file=sys.stderr)
        sys.exit(2)
    question = " ".join(args)

    if deep:
        deep_search(question, model)
    else:
        fast_search(question)


if __name__ == "__main__":
    main()
