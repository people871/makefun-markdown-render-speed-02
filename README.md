# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/people871/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/people871/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked: a dependency-free, single-pass CommonMark + GFM
parser that renders byte-identical HTML to marked 18.1.3 (default options)
while using clearly less CPU. No regex-heavy hot paths, no allocations per
token — one scan over the source, straight to HTML.

## Layout

- `parse.js` — the parser. `parse(markdown)` returns the HTML string.
- `main.ts` — the harness driver: reads `/input/cases.json` (or
  `$MAKEFUN_INPUT_DIR`), renders each case alone with `parse()`, writes
  `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`).

## Run it

```sh
node main.ts
```

Node 22+, no dependencies, no network, no build step.

---

Entered on [make.fun](https://make.fun/?ref=t9cvg4vb&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards
