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
- Do not write queries as if you were using `grep`, package search, or SEO keywords.
- Include disambiguating details such as language, framework, company, version, platform, or time period.
- If the result is about the wrong technology, refine the query immediately.
- If the result is relevant but missing detail, either refine the query or fetch the cited sources.
- Prefer multiple targeted searches over one vague query.

### Rewrite-before-run rule

If your query looks like a bag of nouns, API names, file paths, flags, or endpoint fragments rather than something a person would actually ask, **stop and rewrite it before running the search**.

Before running `web-search search`, quickly check:
- Would a human say this sentence out loud?
- Does it state the actual question I want answered?
- If I removed the quotes, would it read like prose instead of search-engine sludge?

If not, rewrite it.

A good pattern is:
1. Write one sentence describing the fact you want to verify.
2. Turn that sentence into the search query with minimal compression.

### Bad vs good queries

Bad:

```bash
web-search search "Gitea API actions runs jobs logs endpoint repository"
web-search search "tea CLI actions logs Gitea"
web-search search "Axum nested routers state current docs rust"
```

Good:

```bash
web-search search "How do I list workflow runs and fetch job logs from the Gitea Actions API?"
web-search search "Does the tea CLI support viewing Gitea Actions workflow runs or logs?"
web-search search "For the Rust web framework Axum, how are nested routers and state handled in current docs?"
```

Examples of good refinements:

```bash
web-search search "I am asking about the JavaScript bundler called Vite. What changed in its plugin API in Vite 7?"
web-search search "For the Rust web framework Axum, how are nested routers and state handled in current docs?"
```

## Fetch

Use `fetch` to read the contents of a specific source page:

```bash
web-search fetch https://example.com/article
web-search fetch --mode static https://example.com/article
web-search fetch --mode browser-dom https://example.com/article
web-search fetch --mode browser-a11y https://example.com/article
```

Use this when:

- a search result looks promising and you need the actual details
- you want to inspect the original wording of documentation or an announcement
- you need examples, tables, caveats, or exact API details omitted by search summaries

### Fetch modes

- `auto`: default; good first try
- `static`: prefer for normal documentation pages, blogs, and simple HTML pages
- `browser-dom`: prefer for JavaScript-rendered pages, interactive docs, and sites where `static` misses content
- `browser-a11y`: useful fallback when DOM extraction is noisy and the rendered accessibility tree is cleaner

If `fetch` is weak, retry with an explicit mode before giving up.

## Recommended workflow

1. State the question you are trying to answer in one sentence.
2. Start with `web-search search` using that natural-language query.
3. Check whether the answer is about the correct technology and timeframe.
4. Refine the query if the results are ambiguous, off-topic, or too shallow.
5. Use `web-search fetch` on the most relevant cited sources, and retry with an explicit `--mode` if the first extraction is weak.
6. Prefer primary sources when possible: official docs, specs, repos, release notes, or vendor posts.
7. Cross-check important claims when accuracy matters.

## Handling weak or lossy pages

`web-search fetch` works from HTML converted to markdown. Some sites are dynamic, app-like, or PDF-based and may convert poorly.

If a fetched page is incomplete, misleading, missing key content, or comes back as obvious garbage, use this playbook:

1. Retry with an explicit mode:
   - `web-search fetch --mode static <url>`
   - `web-search fetch --mode browser-dom <url>`
   - `web-search fetch --mode browser-a11y <url>`
2. If browser-based fetching fails because of environment issues, profile locks, or browser startup problems, retry with `--mode static`.
3. If the source is a PDF and the extracted output is garbled or low-confidence, do not trust it blindly.
4. Fall back to grabbing the raw content directly:

```bash
curl -L <url>
```

Prefer the least lossy source you can get, and be explicit when a fetch result looks unreliable.

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
