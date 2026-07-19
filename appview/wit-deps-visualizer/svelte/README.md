# deps.etzhayyim.com frontend

## Snapshot Delivery

`deps.etzhayyim.com` の deps snapshot 配信は static asset を正とする。

- 正規生成元は `etzhayyim deps export`
- 生成先は `src/lib/data/*`
- build 前に `70-tools/70-tools/70-tools/scripts/sync-deps-static.mjs` で `static/deps/*` へ同期する
- UI は `/api/deps/graph` を lazy fetch する
- `/api/deps/graph`, `/api/deps/score`, `/api/deps/audit` は compatibility route で、実体は `/deps/wit-graph.json`, `/deps/deps-score.json`, `/deps/deps-audit.json`

## Why static

- snapshot は build 時に確定する
- runtime の整合制御や可変 state を持たない
- client/server bundle に巨大 JSON を埋め込まなくてよい
- Pages の static 配信が最も単純で安い

この app では `Durable Object` も `KV` も使わない。build なし更新が必要になった時だけ再検討する。
