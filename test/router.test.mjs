#!/usr/bin/env node
// Hermetic regression probe for bin/model-router.mjs.
//
// Spins up fake upstream servers that record every request they receive, a
// real router process in front of them, and asserts: model→upstream routing,
// byte-for-byte body fidelity, auth-header passthrough, SSE streaming (not
// buffered), health endpoint, live config reload, token enforcement, and the
// non-loopback-without-token refusal. No network beyond loopback, no real
// credentials, no machine state.
//
// Usage:  node test/router.test.mjs
// Exit:   0 = PASS, 1 = FAIL.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'model-router.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-test-'));
const CONFIG = path.join(TMP, 'config.json');

let failures = 0;
const ok = (msg) => console.log(`PASS: ${msg}`);
const bad = (msg) => { console.log(`FAIL: ${msg}`); failures++; };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

setTimeout(() => { console.log('FAIL: probe timed out'); process.exit(1); }, 30_000).unref();

// --- fake upstreams -------------------------------------------------------------

const CATALOGS = {
  A: [{ id: 'claude-x', type: 'model' }, { id: 'shared-model', type: 'model' }],
  B: [{ id: 'gpt-1', type: 'model' }, { id: 'shared-model', type: 'model' }],
  C: [{ id: 'gpt-sol', type: 'model' }],
};

function mkFake(name) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: CATALOGS[name], has_more: true, first_id: 'x' }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* fine */ }
      if (parsed?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: chunk\ndata: {"n":1}\n\n');
        setTimeout(() => res.write('event: chunk\ndata: {"n":2}\n\n'), 60);
        setTimeout(() => { res.write('event: chunk\ndata: {"n":3}\n\n'); res.end(); }, 120);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'x-served-by': name });
        res.end(JSON.stringify({ served_by: name }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ name, server, port: server.address().port, requests }));
  });
}

// --- router process harness -----------------------------------------------------

function startRouter(configPath, env = {}) {
  const proc = spawn(process.execPath, [BIN, '--config', configPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const m = out.match(/^listening http:\/\/[^:]+:(\d+)$/m);
      if (m) { clearInterval(poll); resolve({ proc, port: Number(m[1]), getOut: () => out, getErr: () => err }); }
      else if (proc.exitCode !== null) { clearInterval(poll); reject(new Error(`router exited ${proc.exitCode}: ${err}`)); }
      else if (Date.now() - started > 5000) { clearInterval(poll); reject(new Error(`router never listened: ${err}`)); }
    }, 20);
  });
}

function waitExit(proc) {
  return new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
}

function request(port, { method = 'POST', path: p = '/v1/messages', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push({ t: Date.now(), data: c }));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks.map((c) => c.data)),
        chunks,
      }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// --- the probe --------------------------------------------------------------------

const [A, B, C] = await Promise.all([mkFake('A'), mkFake('B'), mkFake('C')]);

const baseConfig = {
  listen: { host: '127.0.0.1', port: 0 },
  defaultUpstream: `http://127.0.0.1:${A.port}`,
  routes: [
    { match: 'gpt-5.6-sol', upstream: `http://127.0.0.1:${C.port}` },
    { match: ['gpt-*', 'grok-*'], upstream: `http://127.0.0.1:${B.port}` },
    { match: 'dead-*', upstream: 'http://127.0.0.1:1' },
  ],
};
fs.writeFileSync(CONFIG, JSON.stringify(baseConfig, null, 2));

const router = await startRouter(CONFIG);
const P = router.port;

// 1. Unmatched model → default upstream, bytes + auth headers verbatim.
{
  const body = Buffer.from(JSON.stringify({ model: 'claude-fable-5', max_tokens: 8, messages: [{ role: 'user', content: 'héllo → 世界' }] }));
  const res = await request(P, {
    body,
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer test-oauth-secret',
      'x-api-key': 'test-key-123',
      'anthropic-version': '2023-06-01',
    },
  });
  check(res.status === 200 && res.headers['x-served-by'] === 'A', 'default: claude-* goes to the default upstream');
  const seen = A.requests.at(-1);
  check(seen && seen.body.equals(body), 'default: body forwarded byte-for-byte');
  check(seen?.headers['authorization'] === 'Bearer test-oauth-secret'
     && seen?.headers['x-api-key'] === 'test-key-123'
     && seen?.headers['anthropic-version'] === '2023-06-01', 'default: auth + version headers pass through untouched');
  check(seen?.url === '/v1/messages', 'default: path preserved');
}

// 2. Prefix route — and a second pattern in the same route's match array.
{
  const res = await request(P, { body: JSON.stringify({ model: 'gpt-5.6-mini' }), headers: { 'content-type': 'application/json' } });
  check(res.headers['x-served-by'] === 'B', 'route: gpt-* prefix match forwards to its upstream');
  const res2 = await request(P, { body: JSON.stringify({ model: 'grok-3' }), headers: { 'content-type': 'application/json' } });
  check(res2.headers['x-served-by'] === 'B', 'route: array-form match — any pattern in the list selects the route');
}

// 3. First-match-wins ordering (exact listed before prefix).
{
  const res = await request(P, { body: JSON.stringify({ model: 'gpt-5.6-sol' }), headers: { 'content-type': 'application/json' } });
  check(res.headers['x-served-by'] === 'C', 'route: first matching route wins (exact over later prefix)');
}

// 4. count_tokens routes by model like any other body-bearing endpoint.
{
  const res = await request(P, { path: '/v1/messages/count_tokens', body: JSON.stringify({ model: 'gpt-5.6-mini' }) });
  check(res.headers['x-served-by'] === 'B' && B.requests.at(-1)?.url === '/v1/messages/count_tokens',
    'route: count_tokens follows the model too');
}

// 5. Bodyless request → default upstream.
{
  const res = await request(P, { method: 'GET', path: '/v1/organizations/me' });
  check(res.headers['x-served-by'] === 'A' && A.requests.at(-1)?.url === '/v1/organizations/me', 'default: bodyless GET goes to default upstream');
}

// 5b. GET /v1/models → merged catalog across all upstreams, dead one skipped.
{
  const res = await request(P, { method: 'GET', path: '/v1/models' });
  const j = JSON.parse(res.body.toString());
  const ids = j.data.map((m) => m.id);
  check(res.status === 200
     && ids.includes('claude-x') && ids.includes('gpt-1') && ids.includes('gpt-sol')
     && ids.filter((i) => i === 'shared-model').length === 1
     && j.has_more === false,
    `models: merged catalog, deduped, dead upstream skipped (${ids.join(',')})`);
  check(A.requests.at(-1)?.url === '/v1/models?limit=1000', 'models: default upstream queried with a high page limit');
}

// 5c. GET /v1/models/<id> routes by the id in the path.
{
  await request(P, { method: 'GET', path: '/v1/models/gpt-5.6-mini' });
  check(B.requests.at(-1)?.url === '/v1/models/gpt-5.6-mini', 'models: single-model lookup follows the route');
}

// 6. Non-JSON body → forwarded verbatim to default upstream (upstream's problem).
{
  const junk = Buffer.from('this is { not json');
  await request(P, { body: junk });
  check(A.requests.at(-1)?.body.equals(junk), 'default: unparseable body forwarded verbatim');
}

// 7. SSE streaming passes through incrementally, not buffered.
{
  const res = await request(P, { body: JSON.stringify({ model: 'claude-fable-5', stream: true }) });
  const text = res.body.toString();
  check(res.headers['content-type'] === 'text/event-stream', 'stream: content-type preserved');
  check(text.includes('data: {"n":1}') && text.includes('data: {"n":3}'), 'stream: full event payload delivered');
  const spread = res.chunks.at(-1).t - res.chunks[0].t;
  check(res.chunks.length >= 2 && spread >= 40, `stream: chunks arrived incrementally over ${spread}ms (not buffered)`);
}

// 8. /healthz answered locally.
{
  const res = await request(P, { method: 'GET', path: '/healthz' });
  const j = JSON.parse(res.body.toString());
  check(res.status === 200 && j.ok === true && j.routes === 3, 'healthz: local, ok, route count');
}

// 9. Unreachable upstream → 502 with an Anthropic-shaped error.
{
  const res = await request(P, { body: JSON.stringify({ model: 'dead-model' }) });
  const j = JSON.parse(res.body.toString());
  check(res.status === 502 && j.error?.type === 'upstream_unreachable', 'error: unreachable upstream yields 502');
}

// 10. Live config reload: repoint gpt-* and the very next request follows it.
{
  const edited = structuredClone(baseConfig);
  edited.routes = [{ match: 'gpt-*', upstream: `http://127.0.0.1:${C.port}` }];
  fs.writeFileSync(CONFIG, JSON.stringify(edited, null, 2));
  const res = await request(P, { body: JSON.stringify({ model: 'gpt-5.6-mini' }) });
  check(res.headers['x-served-by'] === 'C', 'reload: config edits apply to the next request');
  fs.writeFileSync(CONFIG, JSON.stringify(baseConfig, null, 2)); // restore…
  await request(P, { method: 'GET', path: '/healthz' });         // …and apply it
}

// 11. Broken config edit → last good config keeps serving.
{
  fs.writeFileSync(CONFIG, '{ broken');
  const res = await request(P, { body: JSON.stringify({ model: 'gpt-5.6-mini' }) });
  check(res.headers['x-served-by'] === 'B', 'reload: broken edit ignored, last good config serves');
  check(router.getErr().includes('config edit ignored'), 'reload: broken edit warned on stderr');
  fs.writeFileSync(CONFIG, JSON.stringify(baseConfig, null, 2));
}

// 12. Mid-stream client abort must not take the router down.
{
  const aborter = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: P, method: 'POST', path: '/v1/messages' },
      (res) => res.once('data', () => resolve(req)),  // first SSE chunk arrived — abort now
    );
    req.on('error', () => {});                        // our own teardown noise is expected
    req.end(JSON.stringify({ model: 'claude-fable-5', stream: true }));
    setTimeout(() => reject(new Error('no first chunk')), 3000);
  });
  aborter.destroy();
  await new Promise((r) => setTimeout(r, 250));       // give a crash time to happen
  const alive = await request(P, { method: 'GET', path: '/healthz' });
  check(alive.status === 200, 'abort: router survives a client vanishing mid-stream');
  const after = await request(P, { body: JSON.stringify({ model: 'gpt-5.6-mini' }) });
  check(after.headers['x-served-by'] === 'B', 'abort: routing still works after the abort');
}

router.proc.kill();

// 13. ROUTER_AUTH_TOKEN set → enforced, and the token header is stripped upstream.
{
  const authed = await startRouter(CONFIG, { ROUTER_AUTH_TOKEN: 'sekrit-42' });
  const noTok = await request(authed.port, { body: JSON.stringify({ model: 'claude-x' }) });
  check(noTok.status === 401, 'auth: request without x-router-token rejected');
  const withTok = await request(authed.port, {
    body: JSON.stringify({ model: 'claude-x' }),
    headers: { 'x-router-token': 'sekrit-42' },
  });
  check(withTok.status === 200 && withTok.headers['x-served-by'] === 'A', 'auth: correct token forwarded');
  check(!('x-router-token' in A.requests.at(-1).headers), 'auth: x-router-token stripped before upstream');
  const health = await request(authed.port, { method: 'GET', path: '/healthz' });
  check(health.status === 200, 'auth: /healthz stays open for monitoring');
  authed.proc.kill();
}

// 14. Non-loopback bind without a token refuses to start.
{
  const openCfg = path.join(TMP, 'open.json');
  fs.writeFileSync(openCfg, JSON.stringify({ ...baseConfig, listen: { host: '0.0.0.0', port: 0 } }));
  const proc = spawn(process.execPath, [BIN, '--config', openCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const code = await waitExit(proc);
  check(code === 1 && err.includes('ROUTER_AUTH_TOKEN'), 'bind: non-loopback without ROUTER_AUTH_TOKEN refuses to start');
}

// 15. Invalid config at startup → exit 1 with message.
{
  const badCfg = path.join(TMP, 'bad.json');
  fs.writeFileSync(badCfg, '{ nope');
  const proc = spawn(process.execPath, [BIN, '--config', badCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const code = await waitExit(proc);
  check(code === 1 && err.includes('not valid JSON'), 'startup: invalid config rejected');
}

// 16. install-launchd subcommand wires through to the shipped installer.
// HERMETIC: launchctl is stubbed via PATH — the real launchd domain must
// never be touched (an earlier version of this case booted the machine's
// LIVE router out of launchd because fake-HOME does not redirect launchctl).
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  const stubBin = path.join(fakeHome, 'stub-bin');
  fs.mkdirSync(stubBin);
  const stubLog = path.join(fakeHome, 'launchctl-calls.log');
  fs.writeFileSync(path.join(stubBin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, { mode: 0o755 });
  const proc = spawn(process.execPath, [BIN, 'install-launchd', '--uninstall'], {
    env: { ...process.env, HOME: fakeHome, PATH: `${stubBin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  const code = await waitExit(proc);
  check(code === 0 && out.includes('uninstalled'), 'cli: install-launchd subcommand reaches the installer');
  const calls = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '';
  check(calls.includes('bootout'), 'cli: launchctl was intercepted by the stub, not the real domain');
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

for (const f of [A, B, C]) f.server.close();
fs.rmSync(TMP, { recursive: true, force: true });

if (failures > 0) { console.log(`FAIL: ${failures} assertion(s) failed.`); process.exit(1); }
console.log('PASS: model-router routes, streams, reloads, and refuses unsafe binds.');
process.exit(0);
