import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { createApp } from '../src/server.mjs';
import { ENDPOINTS, UPSTREAM } from '../src/common.mjs';

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
}

function openRequest(url, options = {}) {
    const req = http.request(url, { ...options, agent: false });
    const response = new Promise((resolve, reject) => {
        req.once('response', resolve);
        req.once('error', reject);
    });
    return { req, response };
}

async function readBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function harness(kind, t, allowedOrigins = '*') {
    const calls = [];
    let handler = (req, res) => res.end('upstream');
    const onRequest = (req, res) => {
        calls.push({ url: new URL(req.url, UPSTREAM), method: req.method, headers: req.headers });
        try {
            Promise.resolve(handler(req, res)).catch(() => res.destroy());
        } catch {
            res.destroy();
        }
    };
    let base;
    if (kind === 'Worker') {
        const modules = {};
        for (const name of ['worker.mjs', 'common.mjs']) {
            modules[name] = { type: 'esm', contents: await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8') };
        }
        const mf = new Miniflare({
            host: '127.0.0.1', port: 0, cf: false,
            log: new Log(LogLevel.NONE), logRequests: false,
            telemetry: { enabled: false },
            workers: [{
                config: {
                    name: 'image-proxy-test', compatibilityDate: '2026-09-01',
                    manifest: { mainModule: 'worker.mjs', modules },
                    env: { ALLOWED_ORIGINS: { type: 'text', value: allowedOrigins } },
                },
                dev: { outboundService: { type: 'node-handler', handler: onRequest } },
            }],
        });
        t.after(() => mf.dispose());
        base = (await mf.ready).origin;
    } else {
        const origin = http.createServer(onRequest);
        const originBase = await listen(origin);
        const proxy = http.createServer(createApp({
            allowedOrigins,
            requestUpstream(url, options, callback) {
                assert.equal(new URL(url).origin, UPSTREAM);
                return http.request(`${originBase}${new URL(url).pathname}${new URL(url).search}`, options, callback);
            },
        }));
        base = await listen(proxy);
        t.after(async () => {
            for (const server of [proxy, origin]) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
        });
    }
    return {
        base, calls,
        setHandler(value) { handler = value; },
        async send(path, { body, ...options } = {}) {
            const { req, response } = openRequest(`${base}${path}`, options);
            req.end(body);
            const res = await response;
            return { status: res.statusCode, headers: res.headers, body: await readBytes(res) };
        },
    };
}

for (const kind of ['Worker', 'Express']) {
    test(`${kind}: transparent image proxy`, { timeout: 60000 }, async t => {
        const h = await harness(kind, t);
        const auth = 'Bearer local-test-token-not-a-real-credential';
        const payload = Buffer.from('{ "input": "测试 \\n prompt", "parameters": { "seed": 1 } }\r\n');

        await t.test('all five paths, query encoding, Authorization and exact request bytes', async () => {
            let received;
            h.setHandler(async (req, res) => {
                received = await readBytes(req);
                res.writeHead(201, { 'content-type': 'application/zip', 'x-correlation-id': 'Ab12Cd' });
                res.end(Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
            });
            for (const [path, method] of ENDPOINTS) {
                const query = '?model=nai-diffusion-3&prompt=a%2Bb+cat&lang=en&x=1&x=2';
                const response = await h.send(path + query, {
                    method, body: method === 'POST' ? payload : undefined,
                    headers: { authorization: auth, 'content-type': 'application/json', 'x-correlation-id': 'Xx12Yy' },
                });
                assert.equal(response.status, 201);
                assert.equal(response.headers['x-correlation-id'], 'Ab12Cd');
                assert.deepEqual(response.body, Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
                const call = h.calls.at(-1);
                assert.equal(call.url.pathname + call.url.search, path + query);
                assert.equal(call.method, method);
                assert.equal(call.headers.authorization, auth);
                assert.equal(call.headers['x-correlation-id'], 'Xx12Yy');
                assert.deepEqual(received, method === 'POST' ? payload : Buffer.alloc(0));
            }
        });

        await t.test('ZIP, PNG, WebP and gzip bytes, length and application headers survive', async () => {
            for (const contentType of ['application/zip', 'image/png', 'image/webp']) {
                for (const compressed of [false, true]) {
                    const binary = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
                    const body = compressed ? gzipSync(binary) : binary;
                    h.setHandler((req, res) => {
                        res.writeHead(200, {
                            'content-type': contentType,
                            'content-length': body.length,
                            'content-disposition': 'attachment; filename="image.bin"',
                            'cache-control': 'private, no-store',
                            'set-cookie': ['one=1; Path=/', 'two=2; Path=/'],
                            ...(compressed ? { 'content-encoding': 'gzip' } : {}),
                        });
                        res.end(body);
                    });
                    const response = await h.send('/ai/upscale', { method: 'POST', body: payload, headers: { 'accept-encoding': 'gzip' } });
                    assert.deepEqual(response.body, body);
                    assert.equal(response.headers['content-type'], contentType);
                    assert.equal(Number(response.headers['content-length']), body.length);
                    assert.equal(response.headers['content-encoding'], compressed ? 'gzip' : undefined);
                    assert.equal(response.headers['content-disposition'], 'attachment; filename="image.bin"');
                    assert.equal(response.headers['cache-control'], 'private, no-store');
                    assert.deepEqual(response.headers['set-cookie'], ['one=1; Path=/', 'two=2; Path=/']);
                }
            }
        });

        await t.test('upstream errors and redirects keep status, bytes and headers without retry', async () => {
            for (const status of [307, 400, 401, 402, 403, 429, 500, 503]) {
                const body = Buffer.from('{ "error" : "unchanged" }\n');
                h.setHandler((req, res) => {
                    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '17', location: 'https://example.invalid/elsewhere' });
                    res.end(body);
                });
                const before = h.calls.length;
                const response = await h.send('/ai/generate-image', { method: 'POST', body: payload });
                assert.equal(response.status, status);
                assert.deepEqual(response.body, body);
                assert.equal(response.headers['retry-after'], '17');
                assert.equal(response.headers.location, 'https://example.invalid/elsewhere');
                assert.equal(h.calls.length, before + 1);
            }
        });

        await t.test('health, unknown paths, wrong methods and CORS preflight stay local', async () => {
            const before = h.calls.length;
            assert.equal((await h.send('/healthz')).body.toString(), 'ok\n');
            assert.equal((await h.send('/healthz', { method: 'HEAD' })).body.length, 0);
            assert.equal((await h.send('/other')).status, 404);
            assert.equal((await h.send('/ai/generate-image')).status, 405);
            const preflight = await h.send('/ai/generate-image', {
                method: 'OPTIONS', headers: {
                    origin: 'http://127.0.0.1:8000',
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'authorization,content-type,x-correlation-id',
                },
            });
            assert.equal(preflight.status, 204);
            assert.equal(preflight.headers['access-control-allow-origin'], '*');
            assert.equal(preflight.headers['access-control-allow-headers'], 'authorization,content-type,x-correlation-id');
            assert.match(preflight.headers.vary, /Access-Control-Request-Headers/);
            assert.equal(h.calls.length, before);
        });

        await t.test('CORS also covers upstream authentication errors', async () => {
            h.setHandler((req, res) => { res.writeHead(401); res.end('unauthorized'); });
            const result = await h.send('/ai/generate-image', { method: 'POST', headers: { origin: 'http://localhost:8000' } });
            assert.equal(result.status, 401);
            assert.equal(result.headers['access-control-allow-origin'], '*');
            assert.equal(result.headers['access-control-expose-headers'], '*');
        });

        await t.test('SSE delivers the first event before the upstream finishes', async () => {
            let finish;
            h.setHandler((req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write('event: intermediate\ndata: first\n\n');
                finish = () => res.end('event: final\ndata: last\n\n');
            });
            const { req, response } = openRequest(`${h.base}/ai/generate-image-stream`, { method: 'POST' });
            req.end(payload);
            const res = await response;
            const iterator = res[Symbol.asyncIterator]();
            const first = await iterator.next();
            assert.equal(first.value.toString(), 'event: intermediate\ndata: first\n\n');
            finish();
            let rest = '';
            for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) rest += chunk.toString();
            assert.equal(rest, 'event: final\ndata: last\n\n');
        });

        await t.test('160 MiB response streams with a matching incremental SHA-256', async () => {
            const chunk = Buffer.alloc(64 * 1024, 0xa5);
            const count = 2560;
            const expected = createHash('sha256');
            for (let i = 0; i < count; i++) expected.update(chunk);
            h.setHandler(async (req, res) => {
                res.writeHead(200, { 'content-type': 'application/zip', 'content-length': count * chunk.length });
                for (let i = 0; i < count; i++) if (!res.write(chunk)) await once(res, 'drain');
                res.end();
            });
            const { req, response } = openRequest(`${h.base}/ai/generate-image`, { method: 'POST' });
            req.end(payload);
            const actual = createHash('sha256');
            let bytes = 0;
            for await (const part of await response) { actual.update(part); bytes += part.length; }
            assert.equal(bytes, count * chunk.length);
            assert.equal(actual.digest('hex'), expected.digest('hex'));
        });

        await t.test('upload chunks reach upstream before the client ends its body', async () => {
            const seen = Promise.withResolvers();
            let received;
            h.setHandler(async (req, res) => {
                req.once('data', chunk => seen.resolve(chunk));
                received = await readBytes(req);
                res.end('done');
            });
            const { req, response } = openRequest(`${h.base}/ai/augment-image`, { method: 'POST' });
            req.write('first chunk');
            assert.equal((await seen.promise).toString(), 'first chunk');
            req.end(' second chunk');
            await readBytes(await response);
            assert.equal(received.toString(), 'first chunk second chunk');
        });

        await t.test('hop-by-hop and client metadata request headers never reach upstream', async () => {
            h.setHandler((req, res) => res.end('ok'));
            await h.send('/ai/upscale', {
                method: 'POST', body: payload,
                headers: {
                    authorization: auth,
                    forwarded: 'for=203.0.113.9',
                    'x-forwarded-for': '203.0.113.9',
                    'x-forwarded-host': 'tavern.invalid',
                    'x-forwarded-proto': 'https',
                    'x-forwarded-port': '443',
                    'x-real-ip': '203.0.113.9',
                    'true-client-ip': '203.0.113.9',
                    'cf-connecting-ip': '203.0.113.9',
                    'cf-ipcountry': 'CN',
                    'cf-ray': '8f2a1b3c4d5e6f70',
                    'cf-visitor': '{"scheme":"https"}',
                    connection: 'keep-alive, x-custom-hop',
                    'x-custom-hop': 'drop-me',
                    te: 'trailers',
                },
            });
            const call = h.calls.at(-1);
            for (const name of [
                'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
                'x-forwarded-port', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip',
                'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-custom-hop', 'te',
            ]) {
                assert.equal(call.headers[name], undefined, `${name} reached upstream`);
            }
            assert.equal(call.headers.authorization, auth);
        });

        await t.test('failed upstream connection returns a generic 502', async () => {
            h.setHandler(() => { throw new Error('upstream unreachable'); });
            const result = await h.send('/ai/generate-image', { method: 'POST', body: payload });
            assert.equal(result.status, 502);
            assert.equal(result.body.toString(), 'NovelAI upstream connection failed.\n');
        });
    });

    test(`${kind}: restricted browser origins`, { timeout: 30000 }, async t => {
        const h = await harness(kind, t, 'http://localhost:8000, http://127.0.0.1:8000');
        assert.equal((await h.send('/ai/upscale', { method: 'POST', headers: { origin: 'https://untrusted.invalid' } })).status, 403);
        assert.equal(h.calls.length, 0);
        const result = await h.send('/ai/upscale', { method: 'POST', headers: { origin: 'http://localhost:8000' } });
        assert.equal(result.headers['access-control-allow-origin'], 'http://localhost:8000');
        assert.match(result.headers.vary, /Origin/);
        assert.equal((await h.send('/ai/upscale', { method: 'POST' })).status, 200);
    });
}
