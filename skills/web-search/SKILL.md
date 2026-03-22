---
name: web-search
description: Search the web and fetch source pages via the installed `web-search` CLI. Use whenever you need current or external information, want to verify uncertain facts, investigate prior art, compare tools, or read online documentation and source material.
compatibility: Requires the `web-search` CLI to be installed and available on PATH.
---

# Web Search

Use this skill whenever external information would improve the answer. Prefer searching over guessing.

## When to use

Use this skill aggressively when:

- you are not confident in a fact
- the information may be recent, fast-moving, or time-sensitive
- the user asks for prior art, comparisons, release notes, standards, APIs, blog posts, or examples
- you need to verify names, versions, behavior, compatibility, or best practices
- multiple technologies share the same name and you need to disambiguate them

If you are about to guess, search first.

## Verify the CLI

Before first use in a session, confirm the CLI is available:

```bash
command -v web-search
```

## Search

Run searches with a human-language query, not keyword soup:

```bash
web-search search "How does Bun's package manager handle workspaces as of 2026?"
web-search search "Find prior art for local-first CRDT note taking apps with end-to-end encryption"
web-search search "What is the current recommended way to add a custom model to pi coding agent?"
```

The command returns a markdown answer plus source links.

### Search guidelines

- Ask a real question or write short prose describing what you need.
- Include disambiguating details such as language, framework, company, version, platform, or time period.
- If the result is about the wrong technology, refine the query immediately.
- If the result is relevant but missing detail, either refine the query or fetch the cited sources.
- Prefer multiple targeted searches over one vague query.

Examples of good refinements:

```bash
web-search search "I am asking about the JavaScript bundler called Vite. What changed in its plugin API in Vite 7?"
web-search search "For the Rust web framework Axum, how are nested routers and state handled in current docs?"
```

## Fetch

Use `fetch` to read the contents of a specific source page:

```bash
web-search fetch https://example.com/article
```

Use this when:

- a search result looks promising and you need the actual details
- you want to inspect the original wording of documentation or an announcement
- you need examples, tables, caveats, or exact API details omitted by search summaries

## Recommended workflow

1. Start with `web-search search` using a natural-language query.
2. Check whether the answer is about the correct technology and timeframe.
3. Refine the query if the results are ambiguous, off-topic, or too shallow.
4. Use `web-search fetch` on the most relevant cited sources.
5. Prefer primary sources when possible: official docs, specs, repos, release notes, or vendor posts.
6. Cross-check important claims when accuracy matters.

## Handling weak or lossy pages

`web-search fetch` works from HTML converted to markdown. Some sites are dynamic or convert poorly.

If a fetched page is incomplete, misleading, or missing key content, fall back to grabbing the raw content directly:

```bash
curl -L <url>
```

## Reporting findings

When using information from this skill:

- summarize the conclusion in your own words
- include the most relevant source URLs
- call out uncertainty or conflicting evidence
- distinguish between primary-source facts and secondary-source commentary

## Quick examples

```bash
web-search search "What prior art exists for terminal-based AI coding assistants with extension systems?"
web-search search "Compare Playwright and Puppeteer for browser automation in 2026, including maintenance status and notable differences"
web-search fetch https://playwright.dev/
```
