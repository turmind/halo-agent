#!/usr/bin/env python3
"""AWS Knowledge MCP Server CLI — wraps https://knowledge-mcp.global.api.aws"""
import sys, json, argparse, urllib.request, urllib.error

MCP_URL = "https://knowledge-mcp.global.api.aws"

def call_mcp(method, params):
    payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req = urllib.request.Request(MCP_URL, data=payload,
        headers={"Content-Type":"application/json","Accept":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def text(result):
    content = result.get("result",{}).get("content",[])
    parts = [c["text"] for c in content if c.get("type")=="text"]
    return "\n".join(parts) if parts else json.dumps(result.get("result",result), indent=2)

def main():
    p = argparse.ArgumentParser(description="AWS Knowledge CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search")
    s.add_argument("query"); s.add_argument("--topics", nargs="+"); s.add_argument("--limit", type=int, default=5)

    r = sub.add_parser("read")
    r.add_argument("url"); r.add_argument("--start", type=int); r.add_argument("--max-length", type=int, dest="max_length")

    rc = sub.add_parser("recommend"); rc.add_argument("url")
    sub.add_parser("regions")

    av = sub.add_parser("availability")
    av.add_argument("resource_type", choices=["product","api","cfn"])
    av.add_argument("--filters", nargs="+"); av.add_argument("--region")

    args = p.parse_args()
    try:
        if args.cmd == "search":
            params = {"search_phrase": args.query}
            if args.topics: params["topics"] = args.topics
            if args.limit: params["limit"] = args.limit
            print(text(call_mcp("tools/call",{"name":"aws___search_documentation","arguments":params})))
        elif args.cmd == "read":
            params = {"url": args.url}
            if args.start: params["start_index"] = args.start
            if args.max_length: params["max_length"] = args.max_length
            print(text(call_mcp("tools/call",{"name":"aws___read_documentation","arguments":params})))
        elif args.cmd == "recommend":
            print(text(call_mcp("tools/call",{"name":"aws___recommend","arguments":{"url":args.url}})))
        elif args.cmd == "regions":
            print(text(call_mcp("tools/call",{"name":"aws___list_regions","arguments":{}})))
        elif args.cmd == "availability":
            params = {"resource_type": args.resource_type}
            if args.filters: params["filters"] = args.filters
            if args.region: params["region"] = args.region
            print(text(call_mcp("tools/call",{"name":"aws___get_regional_availability","arguments":params})))
    except urllib.error.URLError as e:
        print(f"Error: {e}", file=sys.stderr); sys.exit(1)

if __name__ == "__main__":
    main()
