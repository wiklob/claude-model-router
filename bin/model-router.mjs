#!/usr/bin/env node
// claude-model-router — route Anthropic-API requests by model id.
//
// Speaks the Anthropic API surface on localhost, peeks at the `model` field
// of each request, and forwards the ORIGINAL bytes to the upstream that
// serves that model: unmatched ids (claude-*) → api.anthropic.com with the
// caller's own auth untouched; routed ids → a translating proxy of your
// choice (e.g. CLIProxyAPI). Routing only — no API translation, no body
// rewriting, no logging of bodies or credentials.
//
// Usage:  model-router [--config <path>] [--check] [--version] [--help]
// Config: $MODEL_ROUTER_CONFIG or ~/.config/claude-model-router/config.json
// Exit:   0 = clean shutdown / check passed, 1 = config or startup error.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '0.1.0';
// generous ceiling so a malformed client can't balloon memory; real Anthropic
// requests are far smaller
const MAX_BODY = 64 * 1024 * 1024;

// hop-by-hop headers are never forwarded in either direction (RFC 9110 §7.6.1)
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const AUTH_TOKEN = process.env.ROUTER_AUTH_TOKEN || '';

function usage() {
  return `claude-model-router ${VERSION}
Usage: model-router [--config <path>] [--check] [--version] [--help]
       model-router install-launchd [--uninstall]   (macOS: persistent LaunchAgent)
Config resolution: --config > $MODEL_ROUTER_CONFIG > ~/.config/claude-model-router/config.json`;
}

function defaultConfigPath() {
  return process.env.MODEL_ROUTER_CONFIG
    || path.join(os.homedir(), '.config', 'claude-model-router', 'config.json');
}

function compileRoute(r, i) {
  if (!r || typeof r.match !== 'string' || typeof r.upstream !== 'string') {
    throw new Error(`routes[${i}]: need string "match" and string "upstream"`);
  }
  new URL(r.upstream); // throws on a malformed upstream
  const pattern = r.match;
  const test = pattern.endsWith('*')
    ? (id) => id.startsWith(pattern.slice(0, -1))
    : (id) => id === pattern;
  return { match: pattern, upstream: r.upstream.replace(/\/+$/, ''), test };
}

function parseConfig(raw, file) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const listen = cfg.listen || {};
  const host = typeof listen.host === 'string' ? listen.host : '127.0.0.1';
  const port = Number.isInteger(listen.port) ? listen.port : 8399;
  const defaultUpstream = cfg.defaultUpstream || 'https://api.anthropic.com';
  new URL(defaultUpstream);
  const routes = (cfg.routes || []).map(compileRoute);
  return { raw, host, port, defaultUpstream: defaultUpstream.replace(/\/+$/, ''), routes };
}

// Config is re-read per request by content comparison (files this small make
// mtime games pointless) — edits apply live, a broken edit keeps the last
// good config and warns once per breakage.
let CONFIG_FILE;
let config;
let lastConfigError = '';
function currentConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return config; // file briefly missing mid-edit — keep serving
  }
  if (raw === config.raw) return config;
  try {
    const next = parseConfig(raw, CONFIG_FILE);
    config = next;
    lastConfigError = '';
    process.stderr.write(`[model-router] config reloaded (${next.routes.length} route(s))\n`);
  } catch (e) {
    if (lastConfigError !== e.message) {
      lastConfigError = e.message;
      process.stderr.write(`[model-router] config edit ignored: ${e.message}\n`);
    }
  }
  return config;
}

function pickUpstream(cfg, model) {
  if (typeof model === 'string') {
    for (const r of cfg.routes) if (r.test(model)) return r.upstream;
  }
  return cfg.defaultUpstream;
}

function tokenOk(header) {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function forward(req, res, body, upstreamBase) {
  const base = new URL(upstreamBase);
  // preserve an upstream path prefix (e.g. https://host/anthropic + /v1/messages)
  const target = new URL((base.pathname === '/' ? '' : base.pathname) + req.url, base.origin);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === 'host' || k === 'content-length' || k === 'x-router-token') continue;
    headers[k] = v;
  }
  if (body.length > 0 || !['GET', 'HEAD'].includes(req.method)) {
    headers['content-length'] = String(body.length);
  }

  const started = Date.now();
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request(target, { method: req.method, headers }, (upRes) => {
    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (!HOP.has(k)) out[k] = v;
    }
    res.writeHead(upRes.statusCode, out);
    upRes.pipe(res);
    upRes.on('end', () => {
      process.stdout.write(
        `${new Date().toISOString()} ${req.method} ${req.url} -> ${target.host} ${upRes.statusCode} ${Date.now() - started}ms\n`);
    });
  });
  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: `${target.host}: ${e.code || e.message}` } }));
    } else {
      res.destroy();
    }
    process.stderr.write(`[model-router] upstream ${target.host} error: ${e.code || e.message}\n`);
  });
  // a client that goes away must not leak the upstream socket
  res.on('close', () => up.destroy());
  up.end(body);
}

function handle(req, res) {
  res.socket?.setNoDelay(true);
  const cfg = currentConfig();

  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION, defaultUpstream: cfg.defaultUpstream, routes: cfg.routes.length }));
    return;
  }

  if (AUTH_TOKEN && !tokenOk(req.headers['x-router-token'])) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing or wrong x-router-token' } }));
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'body exceeds router limit' } }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let model;
    if (body.length > 0) {
      try { model = JSON.parse(body.toString('utf8')).model; } catch { /* not JSON — default upstream decides */ }
    }
    forward(req, res, body, pickUpstream(cfg, model));
  });
  req.on('error', () => res.destroy());
}

// --- startup ------------------------------------------------------------------

const argv = process.argv.slice(2);

// subcommand: hand off to the installer script that ships in the package,
// wherever the package lives (git checkout or npm install)
if (argv[0] === 'install-launchd') {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install-launchd.sh');
  const r = spawnSync('bash', [script, ...argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

let configFlag = null;
let checkOnly = false;
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--config': configFlag = argv[++i]; break;
    case '--check': checkOnly = true; break;
    case '--version': process.stdout.write(`${VERSION}\n`); process.exit(0); break;
    case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
    default:
      process.stderr.write(`model-router: unknown flag ${argv[i]}\n${usage()}\n`);
      process.exit(1);
  }
}

CONFIG_FILE = configFlag || defaultConfigPath();
try {
  config = parseConfig(fs.readFileSync(CONFIG_FILE, 'utf8'), CONFIG_FILE);
} catch (e) {
  process.stderr.write(`model-router: ${e.message}\n`);
  process.exit(1);
}

if (checkOnly) {
  process.stdout.write(`ok: ${CONFIG_FILE}\n  listen  ${config.host}:${config.port}\n  default ${config.defaultUpstream}\n`);
  for (const r of config.routes) process.stdout.write(`  route   ${r.match} -> ${r.upstream}\n`);
  process.exit(0);
}

if (!LOOPBACK.has(config.host) && !AUTH_TOKEN) {
  process.stderr.write(
    `model-router: refusing to bind non-loopback ${config.host} without ROUTER_AUTH_TOKEN set.\n` +
    `A tokenless non-local bind would relay to your route upstreams for anyone who can reach it.\n` +
    `Put TLS in front of it too (reverse proxy) before exposing it beyond localhost.\n`);
  process.exit(1);
}

const server = http.createServer(handle);
server.requestTimeout = 0;   // long-lived streaming responses are the normal case
server.headersTimeout = 60_000;
server.listen(config.port, config.host, () => {
  const addr = server.address();
  process.stdout.write(`listening http://${config.host}:${addr.port}\n`);
  process.stderr.write(
    `[model-router] ${VERSION} config=${CONFIG_FILE} default=${config.defaultUpstream} ` +
    `routes=${config.routes.length} auth=${AUTH_TOKEN ? 'token' : 'off (loopback)'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
