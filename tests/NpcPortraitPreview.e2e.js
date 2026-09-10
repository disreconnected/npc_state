import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// NPC portrait generation preview flow. The real portrait-ui module is mounted
// against a real in-memory NPC State engine; all network is intercepted
// (generation endpoint from fixtures, image store in memory, everything else
// aborted). No real provider call, no real sidecar or image write occurs.
//
// The extension runtime files are served from this repository's own v03
// directory, so the fixture needs no running SillyTavern host.

const RUNTIME_DIR = new URL('../v03/', import.meta.url);
const RUNTIME_URL_PREFIX = '/scripts/extensions/third-party/npc_state/v03/';
const RUNTIME_FILE = /^[a-z0-9-]+\.(js|css)$/;
// Must stay in sync with the config's baseURL (a loopback origin, so the
// fixture matches the secure context SillyTavern actually runs in).
const FIXTURE_ORIGIN = 'http://127.0.0.1:8000';

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>npc-portrait-preview-test</title></head>
<body>
  <div id="npc_state_settings"><div class="npc-state-drawer">
    <div id="npc_state_v3_main_actions"></div>
  </div></div>
</body>
</html>`;

async function makeFixturePage(page) {
    const fixtures = {
        requests: [],
        uploads: [],
        images: new Map(),
        onGenerate: null,
        responses: [],
        corruptWith: null,
    };
    // Catch-all for real network: serve the extension runtime from this
    // checkout, abort everything else. Restricted to http(s) so in-page
    // `data:`/`blob:` reads (candidate images) keep working normally.
    await page.route(/^https?:\/\//, async route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === FIXTURE_ORIGIN && requestUrl.pathname.startsWith(RUNTIME_URL_PREFIX)) {
            const file = requestUrl.pathname.slice(RUNTIME_URL_PREFIX.length);
            if (RUNTIME_FILE.test(file)) {
                try {
                    const body = await readFile(new URL(file, RUNTIME_DIR));
                    await route.fulfill({
                        status: 200,
                        contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
                        body,
                    });
                } catch {
                    await route.fulfill({ status: 404, body: 'not found' });
                }
                return;
            }
        }
        await route.abort();
    });
    await page.route('**/api/**', async route => { await route.abort(); });
    await page.route('**/api/plugins/npc-state-ima2/generate', async route => {
        const body = JSON.parse(route.request().postData() || '{}');
        fixtures.requests.push(body);
        if (fixtures.onGenerate) {
            await fixtures.onGenerate(route, body);
            return;
        }
        const next = fixtures.responses.shift();
        if (!next) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'IMA2_GENERATION_FAILED', error: 'no fixture' }) });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await page.route('**/user/images/npc-state/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        const base64 = fixtures.images.get(pathname);
        if (base64) {
            await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(base64, 'base64') });
        } else {
            await route.fulfill({ status: 404, body: 'not found' });
        }
    });
    await page.route('**/__fake-image-store/save', async route => {
        const { path, base64 } = JSON.parse(route.request().postData() || '{}');
        fixtures.uploads.push({ path, base64 });
        fixtures.images.set(path, fixtures.corruptWith || base64);
        if (fixtures.corruptWith) fixtures.corruptWith = null;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path }) });
    });
    await page.route('**/npc-portrait-preview-test', route => route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
    await page.goto('/npc-portrait-preview-test');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
    return fixtures;
}

async function mountUi(page, { chatKey = 'chat:owner:test', presets = null } = {}) {
    await page.evaluate(async ({ chatKeyArg, presetsArg }) => {
        const { createNpcStateEngine } = await import('/scripts/extensions/third-party/npc_state/v03/engine.js');
        const { createPortraitPromptUi } = await import('/scripts/extensions/third-party/npc_state/v03/portrait-ui.js');
        const b64ToUtf8 = (b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let index = 0; index < bin.length; index += 1) bytes[index] = bin.charCodeAt(index);
            return new TextDecoder().decode(bytes);
        };
        const files = new Map();
        let pointer = null;
        let activeChatKey = chatKeyArg;
        const settings = {};
        if (presetsArg) {
            settings.portraitPresets = presetsArg;
            settings.portraitActivePresetId = presetsArg[0].id;
        }
        const fetchFn = async (url, options = {}) => {
            if (url === '/api/files/upload') {
                if (window.__portraitPersistFailOnce) {
                    window.__portraitPersistFailOnce = false;
                    throw new Error('simulated persist failure');
                }
                const body = JSON.parse(options.body || '{}');
                const json = b64ToUtf8(body.data);
                const path = `/user/files/${body.name}`;
                files.set(path, json);
                return { ok: true, status: 200, json: async () => ({ path }) };
            }
            if (files.has(url)) return { ok: true, status: 200, text: async () => files.get(url) };
            return { ok: false, status: 404, text: async () => '' };
        };
        const engine = createNpcStateEngine({
            getContext: () => ({ chat: [] }),
            getChatKey: () => activeChatKey,
            getSettings: () => settings,
            getPointer: () => pointer,
            setPointer: (_key, value) => { pointer = structuredClone(value); },
            getLegacyPointer: () => null,
            persistSettings: () => {},
            getHeaders: () => ({}),
            fetchFn,
            generate: async () => { throw new Error('model generation must not run in this fixture'); },
            notify: () => {},
            onStateChanged: () => {},
        });
        window.__portraitUploadControl = { failNext: false, gate: null };
        window.__portraitPersistFailOnce = false;
        const imageUtils = {
            getBase64Async: (blob) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            }),
            getImageSizeFromDataURL: (src) => new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
                image.onerror = () => reject(new Error('failed to load image'));
                image.src = src;
            }),
            saveBase64AsFile: async (base64, folder, name, ext) => {
                const path = `/user/images/${folder}/${name}.${ext}`;
                const control = window.__portraitUploadControl;
                if (control.failNext) {
                    control.failNext = false;
                    throw new Error('simulated upload failure');
                }
                const response = await fetch('/__fake-image-store/save', { method: 'POST', body: JSON.stringify({ path, base64 }) });
                if (!response.ok) throw new Error('image store save failed');
                if (control.gate) {
                    const gate = control.gate;
                    control.gate = null;
                    await gate;
                }
                return path;
            },
        };
        const portraitUi = createPortraitPromptUi({
            engine,
            getSettings: () => settings,
            persistSettings: () => {},
            getChatKey: () => activeChatKey,
            getHeaders: () => ({}),
            imageUtils,
        });
        portraitUi.refresh();
        window.__portraitHarness = {
            engine,
            portraitUi,
            setChatKey: (key) => { activeChatKey = key; },
            uploadControl: window.__portraitUploadControl,
        };
    }, { chatKeyArg: chatKey, presetsArg: presets || null });
}

async function makePngs(page, defs) {
    return page.evaluate(async (items) => {
        const results = [];
        for (const def of items) {
            const canvas = document.createElement('canvas');
            canvas.width = def.width;
            canvas.height = def.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = def.color;
            ctx.fillRect(0, 0, def.width, def.height);
            ctx.strokeStyle = '#111';
            ctx.strokeRect(0.5, 0.5, def.width - 1, def.height - 1);
            const dataUrl = canvas.toDataURL('image/png');
            results.push({ width: def.width, height: def.height, b64: dataUrl.split(',')[1], dataUrl });
        }
        return results;
    }, defs);
}

async function addNpc(page, name) {
    return page.evaluate(async (npcName) => {
        const added = await window.__portraitHarness.engine.addNpc(npcName);
        return added.result.npcId;
    }, name);
}

async function attachPortrait(page, npcId, portrait) {
    await page.evaluate(async ({ id, portrait: portraitArg }) => {
        await window.__portraitHarness.engine.updateNpc(id, { portrait: portraitArg });
    }, { id: npcId, portrait: portrait });
}

async function openGenerate(page, npcId) {
    await page.evaluate((id) => window.__portraitHarness.portraitUi.openFor(id, { generate: true }), npcId);
}

async function attachedState(page, npcId) {
    return page.evaluate((id) => {
        const npc = window.__portraitHarness.engine.getState().npcs.find(item => item.id === id) || null;
        if (!npc?.portrait) return null;
        return {
            url: npc.portrait.url,
            width: npc.portrait.width,
            height: npc.portrait.height,
            mime: npc.portrait.mime,
        };
    }, npcId);
}

test('previews without attaching; apply uploads exactly the selected candidate', async ({ page }) => {
    const fixtures = await makeFixturePage(page);
    await mountUi(page, { chatKey: 'chat:owner:test' });
    const [o, a, b] = await makePngs(page, [
        { width: 32, height: 48, color: '#445566' },
        { width: 40, height: 60, color: '#aa3333' },
        { width: 60, height: 40, color: '#33aa33' },
    ]);
    fixtures.images.set('/user/images/npc-state/O.png', o.b64);
    fixtures.responses = [
        { image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a' },
        { image: b.dataUrl, width: b.width, height: b.height, requestId: 'req-b' },
        { image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a2' },
    ];
    const npcId = await addNpc(page, 'Astra');
    await attachPortrait(page, npcId, { url: '/user/images/npc-state/O.png', mime: 'image/png', sourceName: 'O.png', width: o.width, height: o.height, updatedAt: Date.now() });

    await openGenerate(page, npcId);
    await expect(page.locator('#npc_state_v3_prompt_main_empty')).toBeVisible();
    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);
    await expect(page.locator('#npc_state_v3_prompt_main_empty')).toBeHidden();
    expect(fixtures.requests).toHaveLength(1);
    expect(Object.keys(fixtures.requests[0]).sort()).toEqual(['prompt', 'references']);
    expect(fixtures.requests[0].references).toEqual([o.dataUrl]);
    expect(fixtures.requests[0].prompt).toContain('NEGATIVE');
    expect(fixtures.uploads).toHaveLength(0);
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O.png');
    await expect(page.locator('.npc-state-v3-prompt-apply')).toHaveText(/Use this portrait/);

    const composed = await page.inputValue('#npc_state_v3_prompt_positive');
    await page.fill('#npc_state_v3_prompt_positive', `${composed} EDITED BY TEST`);
    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);
    expect(fixtures.requests).toHaveLength(2);
    expect(fixtures.requests[1].prompt).toContain('EDITED BY TEST');
    expect(fixtures.requests[1].references).toEqual([o.dataUrl]);

    await page.click('.npc-state-v3-prompt-strip-button[aria-label="Preview candidate 1"]');
    await expect(page.locator('.npc-state-v3-prompt-strip-button[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Preview candidate 1');
    expect(await page.inputValue('#npc_state_v3_prompt_positive')).toBe(`${composed} EDITED BY TEST`);

    await page.click('.npc-state-v3-prompt-apply');
    await expect.poll(() => fixtures.uploads.length).toBe(1);
    expect(fixtures.uploads[0].base64).toBe(a.b64);
    await expect.poll(async () => (await attachedState(page, npcId))?.url).toBe(fixtures.uploads[0].path);
    const state = await attachedState(page, npcId);
    expect(state.url).toBe(fixtures.uploads[0].path);
    expect(state.width).toBe(40);
    expect(state.height).toBe(60);
    expect(state.mime).toBe('image/png');
    await expect(page.locator('.npc-state-v3-prompt-apply')).toHaveText(/Current portrait/);
    await expect(page.locator('.npc-state-v3-prompt-apply')).toBeDisabled();
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);

    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(3);
    expect(fixtures.requests).toHaveLength(3);
    expect(fixtures.requests[2].references).toEqual([a.dataUrl]);
});

test('session retention: draft, selection and candidates survive refresh, close/reopen and preset declines', async ({ page }) => {
    const fixtures = await makeFixturePage(page);
    await mountUi(page, {
        chatKey: 'chat:owner:test',
        presets: [
            { id: 'p1', name: 'One', positive: 'style one', negative: 'neg one' },
            { id: 'p2', name: 'Two', positive: 'style two', negative: 'neg two' },
        ],
    });
    const [o, a] = await makePngs(page, [
        { width: 32, height: 48, color: '#445566' },
        { width: 40, height: 60, color: '#aa3333' },
    ]);
    fixtures.images.set('/user/images/npc-state/O.png', o.b64);
    fixtures.responses = [
        { image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a' },
        { image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a2' },
    ];
    const npcId = await addNpc(page, 'Astra');
    await attachPortrait(page, npcId, { url: '/user/images/npc-state/O.png', mime: 'image/png', sourceName: 'O.png', width: o.width, height: o.height, updatedAt: Date.now() });

    await openGenerate(page, npcId);
    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);
    const composed = await page.inputValue('#npc_state_v3_prompt_positive');
    await page.fill('#npc_state_v3_prompt_positive', `${composed} EDITED`);
    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);
    const edited = `${composed} EDITED`;
    await page.fill('#npc_state_v3_prompt_positive', `${edited} MORE`);
    const editedTwo = `${edited} MORE`;

    await page.evaluate(() => window.__portraitHarness.portraitUi.refresh());
    expect(await page.inputValue('#npc_state_v3_prompt_positive')).toBe(editedTwo);
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);

    await page.click('.npc-state-v3-prompt-strip-button[aria-label="Preview candidate 2"]');
    await expect(page.locator('.npc-state-v3-prompt-strip-button[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Preview candidate 2');
    await page.evaluate(() => window.__portraitHarness.portraitUi.closePrompt());
    await openGenerate(page, npcId);
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);
    await expect(page.locator('.npc-state-v3-prompt-strip-button[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Preview candidate 2');
    expect(await page.inputValue('#npc_state_v3_prompt_positive')).toBe(editedTwo);
    expect(fixtures.requests).toHaveLength(2);
    expect(fixtures.uploads).toHaveLength(0);

    await page.evaluate(() => { window.confirm = () => false; });
    await page.selectOption('#npc_state_v3_prompt_preset', 'p2');
    await expect(page.locator('#npc_state_v3_prompt_preset')).toHaveValue('p1');
    expect(await page.inputValue('#npc_state_v3_prompt_positive')).toBe(editedTwo);

    await page.evaluate(() => { window.confirm = () => true; });
    await page.selectOption('#npc_state_v3_prompt_preset', 'p2');
    await expect(page.locator('#npc_state_v3_prompt_preset')).toHaveValue('p2');
    const recomposed = await page.inputValue('#npc_state_v3_prompt_positive');
    expect(recomposed).toContain('style two');
    expect(recomposed).not.toBe(editedTwo);
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(2);

    await page.evaluate(() => window.__portraitHarness.portraitUi.invalidateGenerationContext());
    expect(await page.locator('.npc-state-v3-prompt-shell').count()).toBe(0);
    await openGenerate(page, npcId);
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(0);
    await expect(page.locator('#npc_state_v3_prompt_main_empty')).toBeVisible();

    await page.evaluate(() => window.__portraitHarness.portraitUi.closePrompt());
    await page.evaluate((id) => window.__portraitHarness.portraitUi.openFor(id, { generate: false }), npcId);
    expect(await page.locator('.npc-state-v3-prompt-generate').count()).toBe(0);
    expect(await page.locator('.npc-state-v3-prompt-apply').count()).toBe(0);
    expect(await page.locator('#npc_state_v3_prompt_positive').getAttribute('readonly')).not.toBeNull();
});

test('pending operations are per-NPC and late results cannot cross chats', async ({ page }) => {
    const fixtures = await makeFixturePage(page);
    await mountUi(page, { chatKey: 'chat:owner:test' });
    const [o, a, b] = await makePngs(page, [
        { width: 32, height: 48, color: '#445566' },
        { width: 40, height: 60, color: '#aa3333' },
        { width: 60, height: 40, color: '#33aa33' },
    ]);
    fixtures.images.set('/user/images/npc-state/O.png', o.b64);
    const gates = [];
    fixtures.onGenerate = async (route, body) => {
        if (body.references.length === 0) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: b.dataUrl, width: b.width, height: b.height, requestId: 'req-b' }) });
            return;
        }
        const gate = new Promise(resolve => { gates.push(resolve); });
        await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a' }) });
    };
    const npcIdA = await addNpc(page, 'Astra');
    const npcIdB = await addNpc(page, 'Neri');
    await attachPortrait(page, npcIdA, { url: '/user/images/npc-state/O.png', mime: 'image/png', sourceName: 'O.png', width: o.width, height: o.height, updatedAt: Date.now() });

    await openGenerate(page, npcIdA);
    await page.click('.npc-state-v3-prompt-generate');
    await expect.poll(() => fixtures.requests.length).toBe(1);
    await page.evaluate(() => window.__portraitHarness.portraitUi.closePrompt());
    await openGenerate(page, npcIdA);
    await expect(page.locator('.npc-state-v3-prompt-generate')).toBeDisabled();
    expect(fixtures.requests).toHaveLength(1);

    await openGenerate(page, npcIdB);
    await expect(page.locator('.npc-state-v3-prompt-generate')).toBeEnabled();
    await page.click('.npc-state-v3-prompt-generate');
    await expect.poll(() => fixtures.requests.length).toBe(2);
    expect(fixtures.requests[1].references).toEqual([]);
    gates.shift()();
    await openGenerate(page, npcIdA);
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);

    // Hold a second generation for A, switch chat away, then release: the late
    // response must be discarded and must not show up in the new chat session.
    await page.click('.npc-state-v3-prompt-generate');
    await expect.poll(() => fixtures.requests.length).toBe(3);
    await page.evaluate(() => {
        window.__portraitHarness.setChatKey('chat:owner:other');
        window.__portraitHarness.portraitUi.invalidateGenerationContext();
    });
    gates.shift()();
    await page.evaluate(() => window.__portraitHarness.setChatKey('chat:owner:test'));
    await openGenerate(page, npcIdA);
    await expect.poll(() => page.locator('.npc-state-v3-prompt-shell').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.npc-state-v3-prompt-strip-button').count()).toBe(0);
    await expect(page.locator('.npc-state-v3-prompt-main-empty')).toBeVisible();
    expect(fixtures.uploads).toHaveLength(0);
    expect(await attachedState(page, npcIdA)).not.toBeNull();
});

test('failures preserve the old portrait; apply races and commit failures keep the candidate', async ({ page }) => {
    const fixtures = await makeFixturePage(page);
    await mountUi(page, { chatKey: 'chat:owner:test' });
    const [o, a, b] = await makePngs(page, [
        { width: 32, height: 48, color: '#445566' },
        { width: 40, height: 60, color: '#aa3333' },
        { width: 60, height: 40, color: '#33aa33' },
    ]);
    fixtures.images.set('/user/images/npc-state/O.png', o.b64);
    fixtures.images.set('/user/images/npc-state/O2.png', o.b64);
    const npcId = await addNpc(page, 'Astra');
    await attachPortrait(page, npcId, { url: '/user/images/npc-state/O.png', mime: 'image/png', sourceName: 'O.png', width: o.width, height: o.height, updatedAt: Date.now() });

    let generateCount = 0;
    fixtures.onGenerate = async (route) => {
        generateCount += 1;
        if (generateCount === 2) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'IMA2_GENERATION_FAILED', error: 'provider exploded' }) });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: a.dataUrl, width: a.width, height: a.height, requestId: 'req-a' }) });
    };

    await openGenerate(page, npcId);
    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);

    await page.click('.npc-state-v3-prompt-generate');
    await expect(page.locator('.npc-state-v3-prompt-generate')).toBeEnabled();
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);
    expect(fixtures.requests).toHaveLength(2);
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O.png');

    // Hold an upload, then change the attached portrait before releasing it.
    await page.evaluate(() => {
        window.__portraitHarness.uploadControl.gate = new Promise(resolve => { window.__releasePortraitUpload = () => resolve(); });
    });
    await page.click('.npc-state-v3-prompt-apply');
    await expect.poll(() => fixtures.uploads.length).toBe(1);
    await attachPortrait(page, npcId, { url: '/user/images/npc-state/O2.png', mime: 'image/png', sourceName: 'O2.png', width: o.width, height: o.height, updatedAt: Date.now() });
    await page.evaluate(() => window.__releasePortraitUpload());
    await expect(page.locator('.npc-state-v3-prompt-apply')).toBeEnabled();
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O2.png');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);
    const uploadsBeforeFailure = fixtures.uploads.length;

    // Upload failure: no upload happens, portrait unchanged.
    await page.evaluate(() => { window.__portraitHarness.uploadControl.failNext = true; });
    await page.click('.npc-state-v3-prompt-apply');
    await expect(page.locator('.npc-state-v3-prompt-apply')).toBeEnabled();
    expect(fixtures.uploads.length).toBe(uploadsBeforeFailure);
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O2.png');

    // Wrong decoded size at apply: store the wrong bytes for the upload.
    fixtures.corruptWith = b.b64;
    await page.click('.npc-state-v3-prompt-apply');
    await expect(page.locator('.npc-state-v3-prompt-apply')).toBeEnabled();
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O2.png');
    await expect(page.locator('.npc-state-v3-prompt-strip-button')).toHaveCount(1);

    // Commit failure after a verified upload: candidate/path kept, retry
    // reuses the upload instead of uploading again.
    const uploadsBeforeCommitFailure = fixtures.uploads.length;
    await page.evaluate(() => { window.__portraitPersistFailOnce = true; });
    await page.click('.npc-state-v3-prompt-apply');
    await expect(page.locator('.npc-state-v3-prompt-apply')).toBeEnabled();
    expect(fixtures.uploads.length).toBe(uploadsBeforeCommitFailure + 1);
    expect((await attachedState(page, npcId)).url).toBe('/user/images/npc-state/O2.png');

    await page.click('.npc-state-v3-prompt-apply');
    await expect.poll(async () => (await attachedState(page, npcId))?.url).not.toBe('/user/images/npc-state/O2.png');
    expect(fixtures.uploads.length).toBe(uploadsBeforeCommitFailure + 1, 'retry must reuse the verified upload, not upload again');
    expect((await attachedState(page, npcId)).url).toBe(fixtures.uploads[fixtures.uploads.length - 1].path);
    await expect(page.locator('.npc-state-v3-prompt-apply')).toHaveText(/Current portrait/);
});
