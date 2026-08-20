# Scrapling, as it actually is on this machine

Use this when work touches the `scrapling` Python sidecar. It exists so nobody
spends a paid turn rediscovering an API by traceback.

Verified against **scrapling 0.4.14**, Python 3.11.9, in Flyt's managed
environment (`flyt python status --packages scrapling`). If the version there is
different, verify before trusting a line below — and update this file.

## What it is, and what it is not

Scrapling is a **fetch-and-parse** library: it gets a page past bot defences and
gives you a DOM you can select against. It is **not a search engine**; there is
no `scrapling.search()`. Web search through Scrapling means fetching a search
engine's own results page and parsing it.

## Getting a page

```python
from scrapling.fetchers import Fetcher, StealthyFetcher, DynamicFetcher

page = Fetcher.get(url, timeout=30)                 # HTTP + browser TLS fingerprint
page = StealthyFetcher.fetch(url, headless=True)    # modified browser, Cloudflare
page = DynamicFetcher.fetch(url, network_idle=True) # full Playwright Chromium
```

- `Fetcher` needs only `pip install scrapling[fetchers]` and is what to reach for
  first. It is fast and covers most pages.
- `StealthyFetcher` and `DynamicFetcher` additionally need browsers, and
  `scrapling install` did **not** provide them here — it exited 0 having done
  nothing. What actually worked, verified:
  `patchright install chromium` (Chromium, for `DynamicFetcher`) and
  `pip install "camoufox[geoip]" && python -m camoufox fetch` (Camoufox, for
  `StealthyFetcher`). Both are a few hundred MB and are installed in Flyt's
  managed environment; all three fetchers return 200 there today.
- Without a browser, those two raise a plain `Exception` whose message is a
  box-drawn banner telling you what to install. **Catch it and report the
  remedy, not the traceback** — and note the banner is non-ASCII, so a script
  that prints it under the Windows console codepage dies with
  `UnicodeEncodeError` instead of showing you the problem. `core/python.js`
  sets `PYTHONIOENCODING=utf-8` for exactly this reason.
- `Fetcher.get` sends `referer: https://www.google.com/` by default and logs a
  line to stderr per fetch. Keep stderr out of your JSON on stdout.

## The response

`Response` subclasses `Selector`. Useful members, all verified:

```python
page.status                 # int
page.url                    # str, after redirects
page.body / page.html_content
page.css('.quote .text::text')      # list-like; ::text and ::attr(x) work
page.xpath('//span/text()')
page.css('.result')[0]              # index — there is NO css_first()
page.get_all_text(strip=True, ignore_tags=('script','style'))
page.find_by_text(...) / page.find_similar(...) / page.re_first(...)
page.urljoin(href)
```

**`css_first` does not exist.** Neither does `.get()` in the Scrapy sense on a
list result. Index the list, and guard for empty. A `::text` selector yields
string-ish values; a bare element selector yields `Selector` objects, so
`' '.join(page.css('.snippet'))` raises `TypeError: expected str instance,
Selector found`. Extract text before joining.

## Markdown / text extraction (the part worth stealing)

```python
from scrapling.core.shell import Convertor

md = ''.join(Convertor._extract_content(page, 'markdown', None, True))
txt = ''.join(Convertor._extract_content(page, 'text', None, True))
html = ''.join(Convertor._extract_content(page, 'html', css_selector, False))
```

Signature: `_extract_content(page, extraction_type='markdown'|'html'|'text',
css_selector=None, main_content_only=False)` → a **generator** of strings, one
per matched element when a selector is given.

`main_content_only=True` is the flag that matters. It narrows to `<body>`, drops
`script/style/noscript/svg`, and then runs `_sanitize_for_ai`, which strips
CSS-hidden and `aria-hidden` elements, `<template>` tags, HTML comments,
zero-width Unicode and control characters. That is **prompt-injection surface
removed before the text reaches a model** — the single best reason to prefer
this path over a naive HTML-to-text pass. Use it by default; turn it off only
when the caller asked for the whole document.

Markdown conversion needs `markdownify`, which is **not** in the `[fetchers]`
extra. Without it `_convert_to_markdown` raises `ModuleNotFoundError`. Flyt's
managed environment installs it explicitly; a tool must still degrade to `text`
rather than fail if it is absent.

## Searching, via DuckDuckGo's HTML endpoint

Verified working, no API key:

```python
page = Fetcher.get('https://html.duckduckgo.com/html/?q=' + quote_plus(query), timeout=30)
for r in page.css('.result'):
    title   = r.css('.result__a::text')
    href    = r.css('.result__a::attr(href)')
    snippet = r.css('.result__snippet::text')
```

Two traps:

1. `href` is a DuckDuckGo redirect — `//duckduckgo.com/l/?uddg=<percent-encoded
   target>&rut=…`. Pull the real URL out of the `uddg` query parameter and
   unquote it. A tool that returns the redirect hands the model a URL it cannot
   reason about.
2. Selector text arrives in fragments; join the `::text` list rather than taking
   `[0]`, or snippets come back truncated at the first `<b>`.

The endpoint is a rendered HTML page, not a documented API. Treat a shape change
as expected, keep the parse defensive, and report `results: []` with a reason
rather than throwing.

## The CLI, for reference

`scrapling extract get <url> <out.html|.md|.txt> [-s CSS] [--ai-targeted]`,
plus `fetch` (dynamic) and `stealthy-fetch`. `--ai-targeted` is exactly
`main_content_only=True`. Useful for checking behaviour by hand; **do not build
a tool on it** — it writes to a file, and a Flyt tool wants JSON on stdout
through `core/python.js`.

## Rules for a Scrapling-backed Flyt tool

- Everything it returns is `trust: 'untrusted'` and must say so in its result.
  Scraping is a *higher* injection risk than plain fetching, not a lower one:
  the pages worth using stealth on are the ones that did not want you there.
- Missing package, missing browser → `{ available: false, reason, remedy }` and
  a clean exit. Name `flyt python setup --packages scrapling` or
  `scrapling install`.
- Bound the output. A scraped page can be megabytes; cap it and archive the full
  result, exactly as `web_fetch` does.
- Default to `Fetcher`. Escalating to a real browser costs seconds and memory,
  so make it a parameter the caller chooses, never the default.
