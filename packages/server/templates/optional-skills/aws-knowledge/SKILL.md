---
name: aws-knowledge
description: Query the official AWS Knowledge MCP server for up-to-date AWS documentation, API references, best practices, troubleshooting guides, CDK/CloudFormation examples, What's New announcements, and regional availability. Activate when the user asks any AWS question — services, APIs, errors, architecture, new features, regional support, or "how do I do X on AWS". Always prefer this over general knowledge for AWS topics.
---
# AWS Knowledge

Wraps `https://knowledge-mcp.global.api.aws` — official AWS MCP server. No auth, no dependencies.

## Script

```bash
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py <command> [args]
```

## Commands

### search — use this first for almost everything

```bash
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py search "<phrase>" \
  [--topics TOPIC1 TOPIC2] [--limit N]
```

**Topic selection (up to 3):**

| Query type | Topic |
|---|---|
| API / SDK / CLI code | `reference_documentation` |
| New features / announcements | `current_awareness` |
| Errors / debugging | `troubleshooting` |
| Amplify apps | `amplify_docs` |
| CDK concepts / API / CLI | `cdk_docs` |
| CDK code samples / patterns | `cdk_constructs` |
| CloudFormation templates | `cloudformation` |
| Architecture / best practices / blogs | `general` |

Default topic: `general`. Include service name + language in phrase for best results.

### read — fetch a full doc page as markdown

```bash
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py read "<url>" \
  [--start N] [--max-length N]
```

For long docs, paginate with `--start <char_index>`.

### recommend — related pages

```bash
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py recommend "<docs.aws.amazon.com url>"
```

### availability — check if service/API/CFN resource is in a region

```bash
# product (service or feature)
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py availability product \
  --filters "AWS Lambda" "Amazon Bedrock" [--region ap-northeast-1]

# API operation
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py availability api \
  --filters "Lambda+InvokeFunction"

# CloudFormation resource
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py availability cfn \
  --filters "AWS::Lambda::Function"
```

### regions

```bash
python3 ~/.halo/global/skills/aws-knowledge/scripts/aws_kb.py regions
```

## Workflow

1. **search** → get URLs and summaries
2. **read** top URL for full content
3. **recommend** to explore related pages
4. **availability** for "is X available in region Y" questions
