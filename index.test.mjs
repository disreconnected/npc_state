import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath(path.resolve(import.meta.dirname, '../../config.yaml'));

const { requestIma2Portrait, extractPortraitInput, init } = await import('./index.mjs');
const PNG_1PX = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1f240000000049454e44ae426082',
    'hex',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX.toString('base64')}`;


function writeRuntimeFile(dir, port) {
    const runtimeFile = path.join(dir, 'server.json');
    fs.writeFileSync(runtimeFile, JSON.stringify({
        port,
        url: `http://127.0.0.1:${port}`,
        adminNonce: 'secret-nonce',
        backend: { configuredPort: port, actualPort: port },
        oauth: { status: 'ready' },
    }));
    return runtimeFile;
}

/**
 * Starts an ephemeral fake Ima2 server. Records every request; the handler
 * can be swapped per test through `state.handler`.
 */
async function startFakeIma2() {
    const state = { requests: [], handler: null };
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const record = {
                method: request.method,
                url: request.url,
                headers: { ...request.headers },
                body: Buffer.concat(chunks).toString('utf8'),
            };
            state.requests.push(record);
            const handler = state.handler || ((req, res) => {
                if (req.url === '/api/health') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({
                        ok: true,
                        version: '3.14.0',
                        runtime: { backend: { actualPort: state.port }, oauth: { status: 'ready' } },
                    }));
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ image: PNG_DATA_URL, requestId: JSON.parse(req.body || '{}').requestId, model: 'gpt-5.6-sol', quality: 'high', reasoningEffort: 'max', size: '2160x3840', moderation: 'low' }));
            });
            handler(record, response);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    state.port = server.address().port;
    return { server, state, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'npc-state-ima2-'));
}

test('valid prompt and reference return the exact PNG bytes and dimensions', async () => {
    const fake = await startFakeIma2();
    const dir = tempDir();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        const result = await requestIma2Portrait({ prompt: 'A portrait', references: [PNG_DATA_URL] }, { runtimeFile, fetchFn: globalThis.fetch });
        assert.equal(result.image, PNG_DATA_URL);
        assert.equal(result.width, 1);
        assert.equal(result.height, 1);
        assert.ok(result.requestId);
        const generate = fake.state.requests.find(request => request.url === '/api/generate');
        const body = JSON.parse(generate.body);
        assert.equal(body.model, 'gpt-5.6-sol');
        assert.equal(body.quality, 'high');
        assert.equal(body.reasoningEffort, 'max');
        assert.equal(body.size, '2160x3840');
        assert.equal(body.provider, 'oauth');
        assert.equal(body.mode, 'direct');
        assert.equal(body.moderation, 'low');
        assert.equal(body.webSearchEnabled, false);
        assert.equal(body.n, 1);
        assert.equal(body.format, 'png');
        assert.equal(body.references[0], PNG_DATA_URL);
        assert.equal(generate.headers.cookie, undefined);
        assert.equal(generate.headers.authorization, undefined);
        assert.equal(generate.headers['x-csrf-token'], undefined);
        assert.equal(generate.headers.origin, undefined);
        assert.equal(generate.headers.host, `127.0.0.1:${fake.port}`);
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('invalid inputs are rejected without contacting Ima2', async () => {
    const fake = await startFakeIma2();
    const dir = tempDir();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        const cases = [
            { input: null },
            { input: [] },
            { input: { prompt: '', references: [] } },
            { input: { prompt: '   ', references: [] } },
            { input: { prompt: 'x'.repeat(32001), references: [] } },
            { input: { prompt: 'ok', references: [] }, extra: { model: 'gpt-5.6-luna' } },
            { input: { prompt: 'ok', references: [] }, extra: { moderation: 'low' } },
            { input: { prompt: 'ok', references: [] }, extra: { providerUrl: 'http://evil.example' } },
            { input: { prompt: 'ok', references: ['http://127.0.0.1/x.png'] } },
            { input: { prompt: 'ok', references: ['data:image/png;base64,!!!'] } },
            { input: { prompt: 'ok', references: ['data:image/gif;base64,R0lGOD'] } },
            { input: { prompt: 'ok', references: ['data:image/png;base64,'] } },
            { input: { prompt: 'ok', references: [PNG_DATA_URL, PNG_DATA_URL] } },
        ];
        for (const { input, extra } of cases) {
            await assert.rejects(
                () => requestIma2Portrait(extra ? { ...input, ...extra } : input, { runtimeFile, fetchFn: globalThis.fetch }),
                error => Boolean(error.code === 'INVALID_PORTRAIT_REQUEST' && error.status === 400),
            );
        }
        assert.equal(fake.state.requests.length, 0, 'no request may reach Ima2 for invalid input');
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('missing or invalid runtime metadata fails closed', async () => {
    const fake = await startFakeIma2();
    const dir = tempDir();
    try {
        const missing = path.join(dir, 'absent.json');
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile: missing, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        const badPort = path.join(dir, 'bad-port.json');
        fs.writeFileSync(badPort, JSON.stringify({ port: 70000 }));
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile: badPort, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        const badJson = path.join(dir, 'bad.json');
        fs.writeFileSync(badJson, '{not json');
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile: badJson, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        assert.equal(fake.state.requests.length, 0);
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('unhealthy or redirected Ima2 fails with IMA2_UNAVAILABLE', async () => {
    const dir = tempDir();
    const fake = await startFakeIma2();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        fake.state.handler = (req, res) => {
            if (req.url === '/api/health') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, version: '3.14.0', runtime: { backend: { actualPort: 1 }, oauth: { status: 'ready' } } }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
        };
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        fake.state.handler = (req, res) => {
            if (req.url === '/api/health') {
                res.writeHead(302, { location: 'http://127.0.0.1:1/api/health' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
        };
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        fake.state.handler = (req, res) => {
            if (req.url === '/api/health') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, version: '3.14.0', runtime: { backend: { actualPort: fake.port }, oauth: { status: 'offline' } } }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
        };
        await assert.rejects(() => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn: globalThis.fetch }), error => error.code === 'IMA2_UNAVAILABLE');
        assert.equal(fake.state.requests.filter(request => request.url === '/api/generate').length, 0, 'generation must not run when health fails');
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('malformed generation output fails with IMA2_INVALID_IMAGE and no retry', async () => {
    const dir = tempDir();
    const fake = await startFakeIma2();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        const valid = { model: 'gpt-5.6-sol', quality: 'high', reasoningEffort: 'max', size: '2160x3840', moderation: 'low' };
        const cases = [
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: 'not-a-data-url', requestId, ...valid }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: 'data:image/jpeg;base64,AAAA', requestId, ...valid }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, model: 'gpt-5.6-luna' }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, quality: 'medium' }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, reasoningEffort: 'low' }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, size: '1024x1024' }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, moderation: 'auto' }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: PNG_DATA_URL, requestId, ...valid, moderation: undefined }) },
            { expected: 'IMA2_GENERATION_FAILED', build: () => ({ image: PNG_DATA_URL, requestId: 'other', ...valid }) },
            { expected: 'IMA2_INVALID_IMAGE', build: requestId => ({ image: `data:image/png;base64,${Buffer.from('not png').toString('base64')}`, requestId, ...valid }) },
        ];
        for (const { expected, build } of cases) {
            fake.state.handler = (req, res) => {
                if (req.url === '/api/health') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ ok: true, version: '3.14.0', runtime: { backend: { actualPort: fake.port }, oauth: { status: 'ready' } } }));
                }
                const requestId = JSON.parse(req.body || '{}').requestId;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(build(requestId)));
            };
            await assert.rejects(
                () => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn: globalThis.fetch }),
                error => Boolean(error.code === expected && error.requestId),
            );
        }
        assert.equal(fake.state.requests.filter(request => request.url === '/api/generate').length, cases.length, 'exactly one generation attempt per case');
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('generation failure surfaces IMA2_GENERATION_FAILED with the request id', async () => {
    const dir = tempDir();
    const fake = await startFakeIma2();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        fake.state.handler = (req, res) => {
            if (req.url === '/api/health') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, version: '3.14.0', runtime: { backend: { actualPort: fake.port }, oauth: { status: 'ready' } } }));
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'provider exploded' }));
        };
        await assert.rejects(
            () => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn: globalThis.fetch }),
            error => Boolean(error.code === 'IMA2_GENERATION_FAILED' && error.status === 502 && error.requestId),
        );
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('generation timeout surfaces IMA2_TIMEOUT with the request id', async () => {
    const dir = tempDir();
    const fake = await startFakeIma2();
    try {
        const runtimeFile = writeRuntimeFile(dir, fake.port);
        const fetchFn = (url, options) => String(url).endsWith('/api/generate')
            ? Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
            : globalThis.fetch(url, options);
        await assert.rejects(
            () => requestIma2Portrait({ prompt: 'ok', references: [] }, { runtimeFile, fetchFn }),
            error => Boolean(error.code === 'IMA2_TIMEOUT' && error.status === 504 && error.requestId),
        );
        assert.equal(fake.state.requests.filter(request => request.url === '/api/generate').length, 0);
    } finally {
        await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('registered route rejects non-admin users before reaching Ima2', async () => {
    const fake = await startFakeIma2();
    const app = express();
    app.use(express.json({ limit: '500mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { admin: false } };
        next();
    });
    const router = express.Router();
    await init(router);
    app.use('/api/plugins/npc-state-ima2', router);
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => setImmediate(resolve));
    try {
        const stPort = listener.address().port;
        const response = await fetch(`http://127.0.0.1:${stPort}/api/plugins/npc-state-ima2/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'ok', references: [] }),
        });
        assert.equal(response.status, 403);
        assert.equal(fake.state.requests.length, 0, 'admin middleware must stop requests before any provider contact');
    } finally {
        await new Promise(resolve => listener.close(resolve));
        await fake.close();
    }
});

test('extractPortraitInput rejects unknown keys outright', () => {
    assert.throws(() => extractPortraitInput({ prompt: 'ok', references: [], model: 'x' }), error => error.code === 'INVALID_PORTRAIT_REQUEST');
    assert.throws(() => extractPortraitInput({ prompt: 'ok' }), error => error.code === 'INVALID_PORTRAIT_REQUEST');
    assert.deepEqual(extractPortraitInput({ prompt: 'ok', references: [] }), { prompt: 'ok', references: [] });
});
