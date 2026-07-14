# claude-model-router

A tiny local router for the **Anthropic API surface**. It looks at the `model` id of each request and forwards the original bytes to the upstream that serves that model:

```
Claude Code / SDK app / curl
        │  ANTHROPIC_BASE_URL=http://localhost:8399     (set once)
        ▼
   model-router                reads config.json, hot-reloads on edit
   ├─ claude-*  (unmatched) →  api.anthropic.com    your auth passes through untouched
   └─ gpt-*     (routed)    →  http://localhost:8317  a translating proxy (e.g. CLIProxyAPI)
```

After that, model choice is just `--model` / `/model` — per session, switchable mid-session, from any launcher (terminal, desktop app, background agents). No per-session env juggling, and a foreign model id can *structurally* never be sent to Anthropic: every request resolves at the router.

## What it deliberately is not

**Routing is trivial and stable; API translation is hard and churns.** This router does routing only — no Anthropic↔OpenAI translation, no body rewriting, no auth brokering. For non-Anthropic models, point a route at a proxy that does the translating (e.g. [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)); the router's job is to keep that proxy *off the path* of your normal Claude traffic, so your primary provider never depends on it. Proxy down = foreign routes down, Claude unaffected.

## Quickstart

Via npm:

```bash
npm install -g @wiklob/claude-model-router
model-router install-launchd         # macOS: persistent LaunchAgent (KeepAlive),
                                     # seeds ~/.config/claude-model-router/config.json
```

or from a checkout:

```bash
git clone https://github.com/wiklob/claude-model-router.git
cd claude-model-router
node bin/model-router.mjs --config config.example.json   # foreground trial run
bash install-launchd.sh                                  # persistent install
bash install-launchd.sh --uninstall
```

(`npx @wiklob/claude-model-router` works for a foreground trial too, but don't `install-launchd` from npx — the LaunchAgent would point into the disposable npx cache. Persistence wants a global install or a checkout.)

Point Claude Code at it — in `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8399" } }
```

or per shell: `export ANTHROPIC_BASE_URL=http://localhost:8399`. Then `claude --model <anything>`.

## Configuration

`~/.config/claude-model-router/config.json` (or `--config` / `$MODEL_ROUTER_CONFIG`):

```json
{
  "listen": { "host": "127.0.0.1", "port": 8399 },
  "defaultUpstream": "https://api.anthropic.com",
  "routes": [
    { "match": "gpt-*", "upstream": "http://localhost:8317" }
  ]
}
```

- `match` — exact model id, or a prefix ending in `*`. First matching route wins; no match (and any request without a parseable `model`) → `defaultUpstream`.
- `upstream` — any base URL speaking the Anthropic API surface; a path prefix is preserved.
- Edits apply on the next request (content-compare reload); a broken edit is ignored with a warning and the last good config keeps serving.
- `--check` validates a config and prints the resolved table.

**No credentials, ever, in this file.** The router carries the caller's own headers through untouched.

## Security model

- **Loopback by default.** The router sits on-path for every request — including your Anthropic subscription/API credentials in the headers. Keeping it on `127.0.0.1` means those bytes never leave the machine, and streaming costs ~0 added latency.
- **Non-loopback binds are refused** unless `ROUTER_AUTH_TOKEN` is set; with it set, every request must carry `x-router-token: <token>` (constant-time compared, stripped before forwarding; `/healthz` stays open). Terminate TLS in front of it (reverse proxy) before exposing it beyond localhost — an unprotected relay would hand your route upstreams to anyone who can reach it.
- **No bodies or credentials are ever logged.** The access log is method, path, upstream host, status, duration.

## Behavior details

- Bytes in, bytes out: the request body is buffered once (to peek `model`), then forwarded verbatim; responses — including SSE streams — are piped through unbuffered.
- Hop-by-hop headers are dropped per RFC 9110; everything else (auth, `anthropic-version`, beta flags, compression negotiation) passes through untouched in both directions.
- `GET /healthz` answers locally: `{ok, version, defaultUpstream, routes}`.
- Unreachable upstream → `502` with an Anthropic-shaped error body.
- Long-lived streaming responses are the normal case: no request timeout.

## Testing

```bash
npm test    # = node test/router.test.mjs
```

Hermetic probe: fake upstreams that record what they receive, a real router process in front, assertions on routing, byte fidelity, header passthrough, incremental SSE delivery, hot reload, token enforcement, and unsafe-bind refusal. Loopback only, no real credentials.

## Requirements

`node` ≥ 18. No dependencies. The LaunchAgent installer is macOS; on Linux, run it under systemd or any supervisor (`node bin/model-router.mjs --config …`).

## License

MIT
