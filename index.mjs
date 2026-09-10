/**
 * NPC State Ima2 bridge.
 *
 * Server-side proxy that forwards one reviewed NPC-portrait request to the
 * locally installed Ima2 runtime (http://127.0.0.1:<port>/api/generate) using
 * its existing OAuth lane. Mounted by SillyTavern's plugin loader at
 * /api/plugins/npc-state-ima2 behind the normal login, CSRF, and host
 * protections; additionally gated to admin users because it spends the local
 * OS user's Ima2 OAuth quota.
 *
 * The bridge validates and fixes every forwarded field server-side: the
 * browser may only send { prompt, references }. It never forwards browser
 * cookies, authorization, origin, host, or CSRF headers to Ima2, never
 * follows redirects, and never returns upstream internals to the client.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import fetch from 'node-fetch';
import { imageSize } from 'image-size';

import { requireAdminMiddleware } from '../../src/users.js';

export const info = {
    id: 'npc-state-ima2',
    name: 'NPC State Ima2',
    description: 'Generate NPC portraits through the local Ima2 runtime.',
};

const MAX_PROMPT_CHARS = 32_000;
const MAX_REF_B64_CHARS = 7 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const GENERATION_TIMEOUT_MS = 600_000;
const HEALTH_MAX_BYTES = 1024 * 1024;
const GENERATION_MAX_BYTES = 64 * 1024 * 1024;
const MODEL = 'gpt-5.6-sol';
const QUALITY = 'high';
const REASONING_EFFORT = 'max';
const SIZE = '2160x3840';
const MODERATION = 'low';

const ERROR_MESSAGES = Object.freeze({
    INVALID_PORTRAIT_REQUEST: 'The portrait request was rejected before generation.',
    IMA2_UNAVAILABLE: 'The Ima2 runtime is not reachable or not ready.',
    IMA2_TIMEOUT: 'The Ima2 generation request timed out.',
    IMA2_GENERATION_FAILED: 'Ima2 failed to generate the portrait.',
    IMA2_INVALID_IMAGE: 'Ima2 returned an unusable portrait image.',
});

class PortraitBridgeError extends Error {
    constructor(code, status, { requestId = null } = {}) {
        super(ERROR_MESSAGES[code] || 'Portrait generation failed.');
        this.name = 'PortraitBridgeError';
        this.code = code;
        this.status = status;
        this.requestId = requestId;
    }
}

const fail = (code, status, requestId = null) => { throw new PortraitBridgeError(code, status, { requestId }); };

/**
 * Reads a response body as UTF-8 text while enforcing a hard byte ceiling.
 * Uses the content-length hint when present, then accumulates chunks until
 * the cap is exceeded.
 */
async function readBoundedText(response, maxBytes) {
    const declared = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const body = response?.body;
    if (!body) return '';
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        total += chunk.length;
        if (total > maxBytes) return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function isTimeoutError(error) {
    return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.type === 'aborted';
}

/**
 * Validates one browser-supplied reference. Only same-payload base64 data
 * URLs of PNG/JPEG/WebP are accepted; HTTP URLs and filesystem paths never
 * reach generation. Returns the validated data URL unchanged.
 */
function validateReferenceDataUrl(value) {
    if (typeof value !== 'string') fail('INVALID_PORTRAIT_REQUEST', 400);
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) fail('INVALID_PORTRAIT_REQUEST', 400);
    const declaredMime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    const b64 = match[2];
    if (b64.length === 0 || b64.length % 4 !== 0 || b64.length > MAX_REF_B64_CHARS) fail('INVALID_PORTRAIT_REQUEST', 400);
    let bytes;
    try { bytes = Buffer.from(b64, 'base64'); } catch { fail('INVALID_PORTRAIT_REQUEST', 400); }
    if (bytes.length === 0) fail('INVALID_PORTRAIT_REQUEST', 400);
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { fail('INVALID_PORTRAIT_REQUEST', 400); }
    const detectedMime = dimensions?.type === 'png' ? 'image/png'
        : dimensions?.type === 'jpg' || dimensions?.type === 'jpeg' ? 'image/jpeg'
            : dimensions?.type === 'webp' ? 'image/webp' : null;
    if (!detectedMime || detectedMime !== declaredMime) fail('INVALID_PORTRAIT_REQUEST', 400);
    if (!(Number(dimensions.width) > 0) || !(Number(dimensions.height) > 0)) fail('INVALID_PORTRAIT_REQUEST', 400);
    return value;
}

/**
 * Shapes and validates the request body into the exact { prompt, references }
 * input the bridge forwards. Unknown keys are rejected outright.
 */
export function extractPortraitInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_PORTRAIT_REQUEST', 400);
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('prompt') || !keys.includes('references')) fail('INVALID_PORTRAIT_REQUEST', 400);
    const { prompt, references } = body;
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) fail('INVALID_PORTRAIT_REQUEST', 400);
    if (!Array.isArray(references) || references.length > 1) fail('INVALID_PORTRAIT_REQUEST', 400);
    return { prompt, references: references.map(validateReferenceDataUrl) };
}

/**
 * Reads the runtime metadata the Ima2 CLI wrote for the server user and
 * derives the loopback origin. Only the integer port is trusted; the runtime
 * URL, host, admin nonce, and every other privileged field are ignored.
 */
export async function readRuntimeOrigin(runtimeFile) {
    let raw;
    try { raw = await fs.readFile(runtimeFile, 'utf8'); } catch { fail('IMA2_UNAVAILABLE', 503); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('IMA2_UNAVAILABLE', 503); }
    const port = parsed?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('IMA2_UNAVAILABLE', 503);
    return `http://127.0.0.1:${port}`;
}

/**
 * GETs /api/health with a 5-second timeout and requires the OAuth lane to be
 * ready on the same port the generation request will use.
 */
export async function checkIma2Health(origin, fetchFn) {
    let response;
    try {
        response = await fetchFn(`${origin}/api/health`, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
            headers: { accept: 'application/json' },
        });
    } catch {
        fail('IMA2_UNAVAILABLE', 503);
    }
    if (!response?.ok) fail('IMA2_UNAVAILABLE', 503);
    let text;
    try {
        text = await readBoundedText(response, HEALTH_MAX_BYTES);
    } catch {
        fail('IMA2_UNAVAILABLE', 503);
    }
    if (text === null || text === undefined) fail('IMA2_UNAVAILABLE', 503);
    let data;
    try { data = JSON.parse(text); } catch { fail('IMA2_UNAVAILABLE', 503); }
    const port = Number(new URL(origin).port);
    const runtime = data?.runtime;
    if (data?.ok !== true) fail('IMA2_UNAVAILABLE', 503);
    if (typeof data?.version !== 'string' || data.version.length === 0) fail('IMA2_UNAVAILABLE', 503);
    if (runtime?.backend?.actualPort !== port) fail('IMA2_UNAVAILABLE', 503);
    if (runtime?.oauth?.status !== 'ready') fail('IMA2_UNAVAILABLE', 503);
    return true;
}

/**
 * Validates the generation response: a JSON object echoing the exact fixed
 * generation settings and carrying one nonempty PNG data URL whose decoded
 * header and dimensions are real. Never resizes or re-encodes anything.
 */
export function validateGenerationResult(data, requestId) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('IMA2_INVALID_IMAGE', 502, requestId);
    if (data.requestId !== requestId) fail('IMA2_GENERATION_FAILED', 502, requestId);
    for (const [field, expected] of [['model', MODEL], ['quality', QUALITY], ['reasoningEffort', REASONING_EFFORT], ['size', SIZE], ['moderation', MODERATION]]) {
        if (data[field] !== expected) fail('IMA2_INVALID_IMAGE', 502, requestId);
    }
    const image = data.image;
    if (typeof image !== 'string') fail('IMA2_INVALID_IMAGE', 502, requestId);
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[1].length === 0) fail('IMA2_INVALID_IMAGE', 502, requestId);
    let bytes;
    try { bytes = Buffer.from(match[1], 'base64'); } catch { fail('IMA2_INVALID_IMAGE', 502, requestId); }
    if (bytes.length === 0) fail('IMA2_INVALID_IMAGE', 502, requestId);
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { fail('IMA2_INVALID_IMAGE', 502, requestId); }
    if (dimensions?.type !== 'png' || !(Number(dimensions.width) > 0) || !(Number(dimensions.height) > 0)) fail('IMA2_INVALID_IMAGE', 502, requestId);
    return { image, width: Number(dimensions.width), height: Number(dimensions.height), requestId };
}

/**
 * POSTs exactly one direct-mode generation request to the Ima2 OAuth lane.
 * No async flag, no retries, no provider fallbacks. Returns
 * { image, width, height, requestId } with the dimensions actually returned.
 */
export async function generatePortrait(origin, input, fetchFn) {
    const requestId = crypto.randomUUID();
    const payload = {
        prompt: input.prompt,
        references: input.references,
        provider: 'oauth',
        model: MODEL,
        quality: QUALITY,
        reasoningEffort: REASONING_EFFORT,
        size: SIZE,
        format: 'png',
        moderation: MODERATION,
        mode: 'direct',
        webSearchEnabled: false,
        n: 1,
        requestId,
    };
    let response;
    try {
        response = await fetchFn(`${origin}/api/generate`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        if (isTimeoutError(error)) fail('IMA2_TIMEOUT', 504, requestId);
        fail('IMA2_GENERATION_FAILED', 502, requestId);
    }
    if (!response?.ok) fail('IMA2_GENERATION_FAILED', 502, requestId);
    let text;
    try {
        text = await readBoundedText(response, GENERATION_MAX_BYTES);
    } catch {
        fail('IMA2_GENERATION_FAILED', 502, requestId);
    }
    if (text === null || text === undefined) fail('IMA2_GENERATION_FAILED', 502, requestId);
    let data;
    try { data = JSON.parse(text); } catch { fail('IMA2_GENERATION_FAILED', 502, requestId); }
    return validateGenerationResult(data, requestId);
}

/**
 * Full server-side pipeline: read runtime metadata, verify health, then
 * generate. `options` overrides (runtimeFile, fetchFn) are trusted code and
 * test inputs only; they are never taken from the request body.
 */
export async function requestIma2Portrait(input, { runtimeFile = path.join(os.homedir(), '.ima2', 'server.json'), fetchFn = fetch } = {}) {
    const validated = extractPortraitInput(input);
    const origin = await readRuntimeOrigin(runtimeFile);
    await checkIma2Health(origin, fetchFn);
    return generatePortrait(origin, validated, fetchFn);
}

function respondWithError(response, error) {
    if (error instanceof PortraitBridgeError) {
        console.warn(`[npc-state-ima2] ${error.code}${error.requestId ? ` requestId=${error.requestId}` : ''}`);
        return response.status(error.status).json({
            code: error.code,
            error: ERROR_MESSAGES[error.code],
            ...(error.requestId ? { requestId: error.requestId } : {}),
        });
    }
    console.error('[npc-state-ima2] unexpected bridge failure');
    return response.status(502).json({ code: 'IMA2_GENERATION_FAILED', error: ERROR_MESSAGES.IMA2_GENERATION_FAILED });
}

export async function init(router) {
    router.post('/generate', requireAdminMiddleware, async (request, response) => {
        try {
            const input = extractPortraitInput(request.body);
            const result = await requestIma2Portrait(input);
            return response.json(result);
        } catch (error) {
            return respondWithError(response, error);
        }
    });
}
