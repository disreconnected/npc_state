import {
    PORTRAIT_PRESET_LIMIT,
    PORTRAIT_PROMPT_PLACEHOLDERS,
    buildPortraitPrompt,
    buildPortraitPrompts,
    makePortraitPresetId,
    normalizePortraitPresetLibrary,
    normalizePortraitPromptSettings,
    portraitPromptSettingsForPreset,
} from './portrait-prompt.js';
import { compressPortrait } from './portrait-attachment.js';
import { portraitSource } from './dossier-view.js';
import { findNpcByReference } from './schema.js';

const SECTION_ID = 'npc_state_v3_portrait_prompt';
const PROMPT_OVERLAY_ID = 'npc_state_v3_portrait_prompt_overlay';
const STYLE_ID = 'npc_state_v3_portrait_workflow_style';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function ensureStyleSheet() {
    const doc = globalThis.document;
    if (!doc?.head || doc.getElementById(STYLE_ID)) return Boolean(doc?.getElementById?.(STYLE_ID));
    const link = doc.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = new URL('./portrait-workflow.css', import.meta.url).href;
    doc.head.appendChild(link);
    return true;
}

async function copyText(value) {
    const text = String(value || '');
    if (!text) return false;
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return true;
    }
    const doc = globalThis.document;
    if (!doc?.body || typeof doc.execCommand !== 'function') throw new Error('Clipboard API is unavailable.');
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Browser rejected the clipboard copy request.');
    return true;
}

function fieldHead(title, help) {
    return `<span class="npc-state-v3-portrait-field-head"><b>${escapeHtml(title)}</b><small>${escapeHtml(help)}</small></span>`;
}

function sectionHtml() {
    const placeholderText = PORTRAIT_PROMPT_PLACEHOLDERS.map(key => `{{${key}}}`).join(' · ');
    return `<details id="${SECTION_ID}" class="npc-state-v3-portrait-settings">
      <summary><b>Portrait prompt</b></summary>
      <div class="npc-state-v3-portrait-settings-body">
        <div class="npc-state-v3-portrait-intro">Prompt composition only. Presets are named reusable positive/negative pairs. Generating an actual portrait is a separate action: use Generate NPC Portrait in a dossier's More menu, which calls the local Ima2 runtime.</div>

        <div class="npc-state-v3-portrait-control-grid">
          <label class="npc-state-v3-portrait-control-row">
            ${fieldHead('Character formatting', 'Controls only the auto-built {{character}} placeholder.')}
            <select id="npc_state_v3_portrait_mode" class="text_pole"><option value="natural">Natural</option><option value="tags">Tags</option><option value="hybrid">Hybrid</option></select>
          </label>
          <label class="npc-state-v3-portrait-control-row">
            ${fieldHead('Default preset', 'Used by portrait-prompt API calls and preselected in the dossier prompt dialog.')}
            <select id="npc_state_v3_portrait_preset_select" class="text_pole"></select>
          </label>
        </div>

        <section class="npc-state-v3-portrait-card npc-state-v3-portrait-preset-card">
          <header class="npc-state-v3-portrait-card-head">
            <div><b>Preset library</b><small>Up to ${PORTRAIT_PRESET_LIMIT} named positive/negative pairs.</small></div>
            <div class="npc-state-v3-portrait-preset-actions">
              <button type="button" id="npc_state_v3_portrait_new_preset" class="menu_button"><i class="fa-solid fa-plus"></i> New</button>
              <button type="button" id="npc_state_v3_portrait_duplicate_preset" class="menu_button"><i class="fa-solid fa-clone"></i> Duplicate</button>
              <button type="button" id="npc_state_v3_portrait_delete_preset" class="menu_button redWarningBG"><i class="fa-solid fa-trash"></i> Delete</button>
            </div>
          </header>
          <label class="npc-state-v3-portrait-name-field">
            ${fieldHead('Preset name', 'Shown in the dossier prompt chooser.')}
            <input id="npc_state_v3_portrait_preset_name" class="text_pole" maxlength="80">
          </label>
          <div class="npc-state-v3-portrait-preset-pair">
            <label class="npc-state-v3-portrait-field-card">
              ${fieldHead('Positive preset', 'Reusable style, quality, lighting, and composition text. Insert with {{positivePreset}}.')}
              <textarea id="npc_state_v3_portrait_positive_preset" class="text_pole" rows="6"></textarea>
            </label>
            <label class="npc-state-v3-portrait-field-card">
              ${fieldHead('Negative preset', 'Reusable exclusions and negative-quality text. Insert with {{negativePreset}}.')}
              <textarea id="npc_state_v3_portrait_negative_preset" class="text_pole" rows="6"></textarea>
            </label>
          </div>
        </section>

        <section class="npc-state-v3-portrait-card">
          <header class="npc-state-v3-portrait-card-head"><div><b>Prompt templates</b><small>Shared by all presets. Presets supply style text; templates define how dossier facts are assembled.</small></div></header>
          <div class="npc-state-v3-portrait-template-pair">
            <label class="npc-state-v3-portrait-field-card">
              ${fieldHead('Positive prompt template', 'How the positive channel is assembled for the selected NPC.')}
              <textarea id="npc_state_v3_portrait_positive_template" class="text_pole" rows="7"></textarea>
            </label>
            <label class="npc-state-v3-portrait-field-card">
              ${fieldHead('Negative prompt template', 'May be only {{negativePreset}} or may include dossier placeholders too.')}
              <textarea id="npc_state_v3_portrait_negative_template" class="text_pole" rows="7"></textarea>
            </label>
          </div>
          <details class="npc-state-v3-portrait-placeholders"><summary><b>Available placeholders</b></summary><small>${escapeHtml(placeholderText)}</small></details>
        </section>

        <div class="npc-state-v3-portrait-save-row">
          <button id="npc_state_v3_portrait_save" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Save portrait prompt settings</button>
          <span id="npc_state_v3_portrait_dirty" class="npc-state-muted"></span>
        </div>

        <section class="npc-state-v3-portrait-card npc-state-v3-portrait-preview-box">
          <header class="npc-state-v3-portrait-card-head"><div><b>Preview</b><small>Uses the currently edited preset and templates without saving first.</small></div></header>
          <label class="npc-state-v3-portrait-control-row">
            ${fieldHead('Preview NPC', 'Choose any stored dossier, including off-screen or archived NPCs.')}
            <select id="npc_state_v3_portrait_npc" class="text_pole"></select>
          </label>
          <div class="npc-state-v3-portrait-preview-pair">
            <label class="npc-state-v3-portrait-field-card"><span class="npc-state-v3-portrait-field-head"><b>Resolved positive</b></span><textarea id="npc_state_v3_portrait_positive_preview" class="text_pole" rows="10" readonly></textarea></label>
            <label class="npc-state-v3-portrait-field-card"><span class="npc-state-v3-portrait-field-head"><b>Resolved negative</b></span><textarea id="npc_state_v3_portrait_negative_preview" class="text_pole" rows="10" readonly></textarea></label>
          </div>
          <div class="npc-state-v3-portrait-copy-row">
            <button id="npc_state_v3_portrait_copy_positive" class="menu_button"><i class="fa-solid fa-copy"></i> Copy positive</button>
            <button id="npc_state_v3_portrait_copy_negative" class="menu_button"><i class="fa-solid fa-copy"></i> Copy negative</button>
            <button id="npc_state_v3_portrait_copy_both" class="menu_button"><i class="fa-solid fa-copy"></i> Copy both</button>
          </div>
        </section>
      </div>
    </details>`;
}

function promptOptionsHtml(library, selectedId) {
    return library.portraitPresets.map(preset => `<option value="${escapeHtml(preset.id)}" ${preset.id === selectedId ? 'selected' : ''}>${escapeHtml(preset.name)}${preset.id === library.portraitActivePresetId ? ' · default' : ''}</option>`).join('');
}

function promptOverlayHtml(npc, library, { generate = false } = {}) {
    const title = generate ? 'Generate NPC Portrait' : 'Generate image prompt';
    const kicker = generate ? 'GENERATE NPC PORTRAIT' : 'GENERATE IMAGE PROMPT';
    const subtitle = generate
        ? 'Ima2 · Sol · High quality · Max reasoning · 2160 × 3840 · PNG · Filter: Low (relaxed)'
        : 'Compose from the saved dossier. No image provider is called.';
    const readonly = generate ? '' : ' readonly';
    const presetRow = `<label class="npc-state-v3-prompt-preset-row">
        ${fieldHead('Preset', 'Choose any saved positive/negative preset for this NPC. This does not change the default preset.')}
        <select id="npc_state_v3_prompt_preset" class="text_pole">${promptOptionsHtml(library, library.portraitActivePresetId)}</select>
      </label>`;
    const copyButtons = `
        <button type="button" class="menu_button npc-state-v3-prompt-copy-positive"><i class="fa-solid fa-copy"></i> Copy positive</button>
        <button type="button" class="menu_button npc-state-v3-prompt-copy-negative"><i class="fa-solid fa-copy"></i> Copy negative</button>
        <button type="button" class="menu_button npc-state-v3-prompt-copy-both"><i class="fa-solid fa-copy"></i> Copy both</button>`;
    const negativeNote = generate
        ? '<small class="npc-state-v3-prompt-negative-note">Ima2 has no separate negative channel; this text is appended to the prompt as NEGATIVE.</small>'
        : '';
    const body = generate
        ? `<div class="npc-state-v3-prompt-columns">
        <section class="npc-state-v3-prompt-review" aria-label="Portrait review">
          <div class="npc-state-v3-prompt-current">
            <span class="npc-state-v3-portrait-field-head"><b>Current attached portrait</b></span>
            <div class="npc-state-v3-prompt-current-thumb"><img id="npc_state_v3_prompt_current_image" alt="Current attached portrait"></div>
            <div class="npc-state-v3-prompt-current-empty" id="npc_state_v3_prompt_current_empty">No portrait attached</div>
          </div>
          <div class="npc-state-v3-prompt-reference-note" id="npc_state_v3_prompt_reference_note"></div>
          <div class="npc-state-v3-prompt-main">
            <img id="npc_state_v3_prompt_main_image" alt="Selected candidate portrait">
            <div class="npc-state-v3-prompt-main-empty" id="npc_state_v3_prompt_main_empty">Generate a preview to compare portraits.</div>
          </div>
          <div class="npc-state-v3-prompt-main-caption" id="npc_state_v3_prompt_main_caption" aria-live="polite"></div>
          <div class="npc-state-v3-prompt-strip" id="npc_state_v3_prompt_strip" aria-label="Generated candidates"></div>
        </section>
        <div class="npc-state-v3-prompt-editor">
          ${presetRow}
          <div class="npc-state-v3-prompt-generation-pair">
            <label><span class="npc-state-v3-portrait-field-head"><b>Positive prompt</b></span><textarea id="npc_state_v3_prompt_positive" class="text_pole" rows="8"></textarea></label>
            <label><span class="npc-state-v3-portrait-field-head"><b>Negative prompt</b></span>${negativeNote}<textarea id="npc_state_v3_prompt_negative" class="text_pole" rows="8"></textarea></label>
          </div>
          <small class="npc-state-v3-prompt-edit-note">Prompt edits affect the next generation, not the selected image.</small>
        </div>
      </div>`
        : `${presetRow}
        <div class="npc-state-v3-prompt-reference-note" id="npc_state_v3_prompt_reference_note"></div>
        <div class="npc-state-v3-prompt-preview-pair">
          <label><span class="npc-state-v3-portrait-field-head"><b>Positive prompt</b></span><textarea id="npc_state_v3_prompt_positive" class="text_pole" rows="16"${readonly}></textarea></label>
          <label><span class="npc-state-v3-portrait-field-head"><b>Negative prompt</b></span>${negativeNote}<textarea id="npc_state_v3_prompt_negative" class="text_pole" rows="16"${readonly}></textarea></label>
        </div>`;
    const footer = generate
        ? `<div class="npc-state-v3-prompt-action-row">
        <button type="button" class="menu_button npc-state-v3-prompt-generate"><i class="fa-solid fa-wand-magic-sparkles"></i> <span class="npc-state-v3-prompt-generate-label">Generate preview</span></button>
        <button type="button" class="menu_button npc-state-v3-prompt-apply"><i class="fa-solid fa-image-portrait"></i> <span class="npc-state-v3-prompt-apply-label">Use this portrait</span></button>
      </div>
      <div class="npc-state-v3-prompt-copy-row">${copyButtons}</div>
      <span id="npc_state_v3_prompt_status" class="npc-state-v3-prompt-status" role="status" aria-live="polite"></span>`
        : `<div class="npc-state-v3-prompt-copy-row">${copyButtons}</div>`;
    return `<div class="npc-state-v3-prompt-shell" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" data-npc-id="${escapeHtml(npc.id)}" data-generate="${generate ? 'true' : 'false'}" tabindex="-1">
      <header class="npc-state-v3-prompt-header">
        <div><span class="npc-state-kicker">${kicker}</span><h2>${escapeHtml(npc.name)}</h2><small>${escapeHtml(subtitle)}</small></div>
        <button type="button" class="npc-state-v3-prompt-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="npc-state-v3-prompt-body">
        ${body}
      </div>
      <footer class="npc-state-v3-prompt-actions">
        ${footer}
      </footer>
    </div>`;
}

export function createPortraitPromptUi(adapters = {}) {
    const engine = adapters.engine;
    const getSettings = adapters.getSettings;
    const persistSettings = adapters.persistSettings || (() => {});
    const getChatKey = adapters.getChatKey || (() => '');
    const getHeaders = adapters.getHeaders || (() => ({}));
    const imageUtils = adapters.imageUtils || {};
    let dirty = false;
    let draft = null;
    let mountTimer = null;
    let dossierBridgeBound = false;
    let promptFocusBeforeOpen = null;
    const pendingGenerations = new Map();
    const generationSessions = new Map();

    function notify(kind, message) {
        const fn = globalThis.toastr?.[kind];
        if (typeof fn === 'function') fn(`NPC State: ${message}`);
    }

    function panel() { return globalThis.document?.getElementById?.(SECTION_ID) || null; }
    function promptOverlay() { return globalThis.document?.getElementById?.(PROMPT_OVERLAY_ID) || null; }
    function state() { return engine.getState?.() || null; }

    function savedDraft() {
        const settings = getSettings();
        const normalized = normalizePortraitPromptSettings(settings);
        const library = normalizePortraitPresetLibrary(settings);
        return {
            mode: normalized.portraitPromptMode,
            presets: structuredClone(library.portraitPresets),
            activeId: library.portraitActivePresetId,
            positivePrompt: normalized.portraitPositivePrompt,
            negativePrompt: normalized.portraitNegativePrompt,
        };
    }

    function ensureDraft() {
        if (!draft) draft = savedDraft();
        return draft;
    }

    function activeDraftPreset() {
        const current = ensureDraft();
        return current.presets.find(preset => preset.id === current.activeId) || current.presets[0] || null;
    }

    function draftAsSettings(selectedPresetId = '') {
        const current = ensureDraft();
        return {
            portraitPromptMode: current.mode,
            portraitPresets: structuredClone(current.presets),
            portraitActivePresetId: selectedPresetId || current.activeId,
            portraitPositivePrompt: current.positivePrompt,
            portraitNegativePrompt: current.negativePrompt,
        };
    }

    function captureActivePresetFields(root = panel()) {
        if (!root) return false;
        const preset = activeDraftPreset();
        if (!preset) return false;
        preset.name = String(root.querySelector('#npc_state_v3_portrait_preset_name')?.value || '').slice(0, 80);
        preset.positive = String(root.querySelector('#npc_state_v3_portrait_positive_preset')?.value || '');
        preset.negative = String(root.querySelector('#npc_state_v3_portrait_negative_preset')?.value || '');
        ensureDraft().mode = root.querySelector('#npc_state_v3_portrait_mode')?.value || 'hybrid';
        ensureDraft().positivePrompt = String(root.querySelector('#npc_state_v3_portrait_positive_template')?.value || '');
        ensureDraft().negativePrompt = String(root.querySelector('#npc_state_v3_portrait_negative_template')?.value || '');
        return true;
    }

    function renderPresetChoices(root = panel()) {
        if (!root) return false;
        const current = ensureDraft();
        const select = root.querySelector('#npc_state_v3_portrait_preset_select');
        if (!select) return false;
        select.innerHTML = current.presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(String(preset.name || '').trim() || 'Untitled preset')}</option>`).join('');
        select.value = current.activeId;
        return true;
    }

    function renderActivePresetFields(root = panel()) {
        if (!root) return false;
        const preset = activeDraftPreset();
        if (!preset) return false;
        const name = root.querySelector('#npc_state_v3_portrait_preset_name');
        const positive = root.querySelector('#npc_state_v3_portrait_positive_preset');
        const negative = root.querySelector('#npc_state_v3_portrait_negative_preset');
        if (name) name.value = preset.name || '';
        if (positive) positive.value = preset.positive || '';
        if (negative) negative.value = preset.negative || '';
        const deleteButton = root.querySelector('#npc_state_v3_portrait_delete_preset');
        if (deleteButton) deleteButton.disabled = ensureDraft().presets.length <= 1;
        return true;
    }

    function loadDraftFields(root = panel()) {
        if (!root) return false;
        const current = ensureDraft();
        const mode = root.querySelector('#npc_state_v3_portrait_mode');
        const positiveTemplate = root.querySelector('#npc_state_v3_portrait_positive_template');
        const negativeTemplate = root.querySelector('#npc_state_v3_portrait_negative_template');
        if (mode) mode.value = current.mode;
        if (positiveTemplate) positiveTemplate.value = current.positivePrompt;
        if (negativeTemplate) negativeTemplate.value = current.negativePrompt;
        renderPresetChoices(root);
        renderActivePresetFields(root);
        return true;
    }

    function chosenNpc(root = panel()) {
        const id = root?.querySelector('#npc_state_v3_portrait_npc')?.value || '';
        return id ? findNpcByReference(state(), id) : null;
    }

    function renderPreview(root = panel()) {
        if (!root) return { positive: '', negative: '', combined: '' };
        captureActivePresetFields(root);
        const positivePreview = root.querySelector('#npc_state_v3_portrait_positive_preview');
        const negativePreview = root.querySelector('#npc_state_v3_portrait_negative_preview');
        const positiveButton = root.querySelector('#npc_state_v3_portrait_copy_positive');
        const negativeButton = root.querySelector('#npc_state_v3_portrait_copy_negative');
        const bothButton = root.querySelector('#npc_state_v3_portrait_copy_both');
        const npc = chosenNpc(root);
        const selectedSettings = portraitPromptSettingsForPreset(draftAsSettings(), ensureDraft().activeId);
        const values = npc ? buildPortraitPrompts(npc, selectedSettings) : { positive: '', negative: '', combined: '' };
        if (positivePreview) positivePreview.value = values.positive;
        if (negativePreview) negativePreview.value = values.negative;
        if (positiveButton) positiveButton.disabled = !values.positive;
        if (negativeButton) negativeButton.disabled = !values.negative;
        if (bothButton) bothButton.disabled = !values.positive && !values.negative;
        const dirtyLabel = root.querySelector('#npc_state_v3_portrait_dirty');
        if (dirtyLabel) dirtyLabel.textContent = dirty ? 'Unsaved changes' : 'Saved';
        return values;
    }

    function syncNpcChoices(root = panel()) {
        if (!root) return false;
        const select = root.querySelector('#npc_state_v3_portrait_npc');
        if (!select) return false;
        const previous = select.value || '';
        const rows = [...(state()?.npcs || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        select.innerHTML = rows.length
            ? rows.map(npc => `<option value="${escapeHtml(npc.id)}">${escapeHtml(npc.name)}${npc.archived ? ' · archived' : ''}</option>`).join('')
            : '<option value="">No dossiers</option>';
        if (rows.some(npc => npc.id === previous)) select.value = previous;
        return true;
    }

    function markDirty(root = panel()) {
        dirty = true;
        renderPreview(root);
    }

    function switchPreset(id, root = panel()) {
        if (!root) return false;
        captureActivePresetFields(root);
        const current = ensureDraft();
        if (!current.presets.some(preset => preset.id === id)) return false;
        current.activeId = id;
        renderPresetChoices(root);
        renderActivePresetFields(root);
        dirty = true;
        renderPreview(root);
        return true;
    }

    function addPreset(root = panel()) {
        if (!root) return false;
        captureActivePresetFields(root);
        const current = ensureDraft();
        if (current.presets.length >= PORTRAIT_PRESET_LIMIT) {
            notify('warning', `portrait preset limit is ${PORTRAIT_PRESET_LIMIT}.`);
            return false;
        }
        const id = makePortraitPresetId('New preset', current.presets.map(preset => preset.id));
        current.presets.push({ id, name: 'New preset', positive: '', negative: '' });
        current.activeId = id;
        renderPresetChoices(root);
        renderActivePresetFields(root);
        dirty = true;
        renderPreview(root);
        root.querySelector('#npc_state_v3_portrait_preset_name')?.focus?.();
        return true;
    }

    function duplicatePreset(root = panel()) {
        if (!root) return false;
        captureActivePresetFields(root);
        const current = ensureDraft();
        const source = activeDraftPreset();
        if (!source) return false;
        if (current.presets.length >= PORTRAIT_PRESET_LIMIT) {
            notify('warning', `portrait preset limit is ${PORTRAIT_PRESET_LIMIT}.`);
            return false;
        }
        const name = `${String(source.name || 'Preset').trim() || 'Preset'} copy`.slice(0, 80);
        const id = makePortraitPresetId(name, current.presets.map(preset => preset.id));
        current.presets.push({ id, name, positive: source.positive, negative: source.negative });
        current.activeId = id;
        renderPresetChoices(root);
        renderActivePresetFields(root);
        dirty = true;
        renderPreview(root);
        return true;
    }

    function deletePreset(root = panel()) {
        if (!root) return false;
        const current = ensureDraft();
        if (current.presets.length <= 1) return false;
        const source = activeDraftPreset();
        if (!source) return false;
        if (globalThis.confirm && !globalThis.confirm(`Delete portrait preset “${source.name || 'Untitled preset'}”?`)) return false;
        const index = current.presets.findIndex(preset => preset.id === source.id);
        current.presets.splice(index, 1);
        current.activeId = current.presets[Math.max(0, index - 1)]?.id || current.presets[0].id;
        renderPresetChoices(root);
        renderActivePresetFields(root);
        dirty = true;
        renderPreview(root);
        return true;
    }

    async function save(root = panel()) {
        if (!root) return false;
        captureActivePresetFields(root);
        const current = ensureDraft();
        const normalizedLibrary = normalizePortraitPresetLibrary({
            portraitPresets: current.presets,
            portraitActivePresetId: current.activeId,
        });
        const normalized = normalizePortraitPromptSettings({
            portraitPromptMode: current.mode,
            portraitPresets: normalizedLibrary.portraitPresets,
            portraitActivePresetId: normalizedLibrary.portraitActivePresetId,
            portraitPositivePrompt: current.positivePrompt,
            portraitNegativePrompt: current.negativePrompt,
        });
        const settings = getSettings();
        settings.portraitPromptMode = normalized.portraitPromptMode;
        settings.portraitPresets = structuredClone(normalizedLibrary.portraitPresets);
        settings.portraitActivePresetId = normalizedLibrary.portraitActivePresetId;
        settings.portraitPreset = structuredClone(normalized.portraitPreset);
        settings.portraitPositivePrompt = normalized.portraitPositivePrompt;
        settings.portraitNegativePrompt = normalized.portraitNegativePrompt;
        delete settings.portraitGenerationPrompt;
        delete settings.portraitPositivePreset;
        delete settings.portraitNegativePreset;
        delete settings.portraitPresetName;
        persistSettings();
        draft = savedDraft();
        dirty = false;
        loadDraftFields(root);
        renderPreview(root);
        notify('success', `saved ${draft.presets.length} portrait preset${draft.presets.length === 1 ? '' : 's'} and prompt templates.`);
        return true;
    }

    async function copyChannel(channel, root = panel()) {
        const values = renderPreview(root);
        const value = channel === 'negative' ? values.negative : channel === 'both' ? values.combined : values.positive;
        if (!value) return false;
        await copyText(value);
        notify('success', channel === 'both' ? 'positive and negative portrait prompts copied.' : `${channel} portrait prompt copied.`);
        return true;
    }

    function bind(root) {
        root.querySelector('#npc_state_v3_portrait_mode')?.addEventListener('change', () => markDirty(root));
        root.querySelector('#npc_state_v3_portrait_preset_select')?.addEventListener('change', event => switchPreset(event.currentTarget.value, root));
        for (const selector of [
            '#npc_state_v3_portrait_preset_name',
            '#npc_state_v3_portrait_positive_preset',
            '#npc_state_v3_portrait_negative_preset',
            '#npc_state_v3_portrait_positive_template',
            '#npc_state_v3_portrait_negative_template',
        ]) {
            root.querySelector(selector)?.addEventListener('input', () => {
                captureActivePresetFields(root);
                if (selector === '#npc_state_v3_portrait_preset_name') renderPresetChoices(root);
                markDirty(root);
            });
        }
        root.querySelector('#npc_state_v3_portrait_npc')?.addEventListener('change', () => renderPreview(root));
        root.querySelector('#npc_state_v3_portrait_new_preset')?.addEventListener('click', () => addPreset(root));
        root.querySelector('#npc_state_v3_portrait_duplicate_preset')?.addEventListener('click', () => duplicatePreset(root));
        root.querySelector('#npc_state_v3_portrait_delete_preset')?.addEventListener('click', () => deletePreset(root));
        root.querySelector('#npc_state_v3_portrait_save')?.addEventListener('click', () => save(root).catch(error => notify('error', error.message)));
        root.querySelector('#npc_state_v3_portrait_copy_positive')?.addEventListener('click', () => copyChannel('positive', root).catch(error => notify('error', error.message)));
        root.querySelector('#npc_state_v3_portrait_copy_negative')?.addEventListener('click', () => copyChannel('negative', root).catch(error => notify('error', error.message)));
        root.querySelector('#npc_state_v3_portrait_copy_both')?.addEventListener('click', () => copyChannel('both', root).catch(error => notify('error', error.message)));
    }

    function pendingKey(chatKey, npcId) {
        return `${String(chatKey)}\u0000${String(npcId)}`;
    }

    function pendingFor(chatKey, npcId) {
        return pendingGenerations.get(pendingKey(chatKey, npcId)) || null;
    }

    function readPromptValue(channel, root = promptOverlay()) {
        const element = root?.querySelector(`#npc_state_v3_prompt_${channel}`);
        return String(element?.value ?? '');
    }

    function combinedPromptValue(root = promptOverlay()) {
        return `POSITIVE\n${readPromptValue('positive', root)}\n\nNEGATIVE\n${readPromptValue('negative', root)}`.trim();
    }

    function composePromptOverlay(root = promptOverlay()) {
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        const npc = shell ? findNpcByReference(state(), shell.dataset.npcId || '') : null;
        const presetId = root?.querySelector('#npc_state_v3_prompt_preset')?.value || '';
        const values = npc ? buildPortraitPrompts(npc, portraitPromptSettingsForPreset(getSettings(), presetId)) : { positive: '', negative: '', combined: '' };
        const positive = root?.querySelector('#npc_state_v3_prompt_positive');
        const negative = root?.querySelector('#npc_state_v3_prompt_negative');
        if (positive) positive.value = values.positive;
        if (negative) negative.value = values.negative;
        if (shell) {
            shell.dataset.initialPositive = values.positive;
            shell.dataset.initialNegative = values.negative;
        }
        return values;
    }

    function sessionKeyForShell(root = promptOverlay()) {
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        if (!shell) return null;
        const chatKey = String(shell.dataset.chatKey || '');
        const npcId = String(shell.dataset.npcId || '');
        return chatKey && npcId ? pendingKey(chatKey, npcId) : null;
    }

    function sessionForShell(root = promptOverlay()) {
        const key = sessionKeyForShell(root);
        return key ? generationSessions.get(key) || null : null;
    }

    function composeGenerationPrompt(root = promptOverlay(), session = sessionForShell(root)) {
        if (!session) return null;
        const values = buildPairFor(session.npcId, session.presetId);
        session.positive = values.positive;
        session.negative = values.negative;
        session.initialPositive = values.positive;
        session.initialNegative = values.negative;
        return values;
    }

    function generationPromptEdited(root = promptOverlay()) {
        const session = sessionForShell(root);
        if (!session) return false;
        return readPromptValue('positive', root) !== session.initialPositive
            || readPromptValue('negative', root) !== session.initialNegative;
    }

    function updateReferenceNote(root = promptOverlay()) {
        const note = root?.querySelector('#npc_state_v3_prompt_reference_note');
        if (!note) return;
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        const npc = shell ? findNpcByReference(state(), shell.dataset.npcId || '') : null;
        note.textContent = portraitSource(npc || {})
            ? 'The current NPC portrait will be sent as the image reference.'
            : 'No portrait attached: generation will be text-only.';
    }

    /**
     * Renders the review/editor state of the generation dialog, scoped to the
     * chat and NPC captured on its shell. The candidate strip, thumbnails,
     * selection, prompt fields, attached-portrait note and action states all
     * read from the generation session rather than transient DOM state.
     */
    function renderGenerationView(root = promptOverlay()) {
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        if (!shell || shell.dataset.generate !== 'true') return;
        const key = sessionKeyForShell(root);
        if (!key) return;
        const record = pendingGenerations.get(key) || null;
        const session = generationSessions.get(key) || null;
        const busy = Boolean(record);
        const npc = liveNpcById(String(shell.dataset.npcId || ''));
        const attached = portraitSource(npc || {});
        const currentImage = root.querySelector('#npc_state_v3_prompt_current_image');
        const currentEmpty = root.querySelector('#npc_state_v3_prompt_current_empty');
        if (currentImage) {
            currentImage.src = attached || '';
            currentImage.hidden = !attached;
        }
        if (currentEmpty) currentEmpty.hidden = Boolean(attached);
        const note = root.querySelector('#npc_state_v3_prompt_reference_note');
        if (note) {
            note.textContent = attached
                ? 'The current attached portrait will be sent as the image reference.'
                : 'No portrait attached: the next generation is text-only.';
        }
        const candidates = session?.candidates || [];
        const selected = candidates.find(candidate => candidate.id === session?.selectedCandidateId) || null;
        const mainImage = root.querySelector('#npc_state_v3_prompt_main_image');
        const mainEmpty = root.querySelector('#npc_state_v3_prompt_main_empty');
        const caption = root.querySelector('#npc_state_v3_prompt_main_caption');
        if (selected) {
            if (mainImage) { mainImage.src = selected.previewUrl; mainImage.hidden = false; }
            if (mainEmpty) mainEmpty.hidden = true;
            if (caption) caption.textContent = `Candidate ${candidates.indexOf(selected) + 1} · ${selected.width} × ${selected.height}`;
        } else {
            if (mainImage) { mainImage.removeAttribute('src'); mainImage.hidden = true; }
            if (mainEmpty) mainEmpty.hidden = false;
            if (caption) caption.textContent = '';
        }
        const strip = root.querySelector('#npc_state_v3_prompt_strip');
        if (strip) {
            strip.replaceChildren();
            candidates.forEach((candidate, index) => {
                const button = globalThis.document.createElement('button');
                button.type = 'button';
                button.className = 'npc-state-v3-prompt-strip-button';
                button.setAttribute('aria-pressed', String(candidate.id === selected?.id));
                button.setAttribute('aria-label', `Preview candidate ${index + 1}`);
                button.disabled = record?.phase === 'applying';
                const image = globalThis.document.createElement('img');
                image.src = candidate.previewUrl;
                image.alt = '';
                button.appendChild(image);
                button.addEventListener('click', () => {
                    const currentSession = generationSessions.get(key);
                    if (!currentSession || currentSession.invalidated || currentSession !== session) return;
                    currentSession.selectedCandidateId = candidate.id;
                    renderGenerationView(root);
                });
                strip.appendChild(button);
            });
        }
        const positiveField = root.querySelector('#npc_state_v3_prompt_positive');
        const negativeField = root.querySelector('#npc_state_v3_prompt_negative');
        const presetSelect = root.querySelector('#npc_state_v3_prompt_preset');
        if (presetSelect) presetSelect.disabled = busy;
        if (positiveField) positiveField.disabled = busy;
        if (negativeField) negativeField.disabled = busy;
        if (session) {
            if (positiveField) positiveField.value = session.positive;
            if (negativeField) negativeField.value = session.negative;
            if (presetSelect) {
                const library = normalizePortraitPresetLibrary(getSettings());
                if (!library.portraitPresets.some(preset => preset.id === session.presetId)) {
                    session.presetId = library.portraitActivePresetId;
                }
                presetSelect.value = session.presetId;
            }
        }
        const generateButton = root.querySelector('.npc-state-v3-prompt-generate');
        const generateLabel = root.querySelector('.npc-state-v3-prompt-generate .npc-state-v3-prompt-generate-label') || generateButton;
        if (generateButton) generateButton.disabled = busy;
        if (generateLabel) generateLabel.textContent = candidates.length ? 'Regenerate' : 'Generate preview';
        const applyButton = root.querySelector('.npc-state-v3-prompt-apply');
        const applyLabel = root.querySelector('.npc-state-v3-prompt-apply .npc-state-v3-prompt-apply-label') || applyButton;
        const selectedAttached = Boolean(selected?.savedPath && selected.savedPath === attached);
        if (applyButton) applyButton.disabled = busy || !selected || selectedAttached;
        if (applyLabel) applyLabel.textContent = selectedAttached ? 'Current portrait' : 'Use this portrait';
        root.querySelector('.npc-state-v3-prompt-copy-positive')?.toggleAttribute('disabled', !String(positiveField?.value || '').trim());
        root.querySelector('.npc-state-v3-prompt-copy-negative')?.toggleAttribute('disabled', !String(negativeField?.value || '').trim());
        root.querySelector('.npc-state-v3-prompt-copy-both')?.toggleAttribute('disabled', !String(positiveField?.value || '').trim() && !String(negativeField?.value || '').trim());
        const status = root.querySelector('#npc_state_v3_prompt_status');
        if (status) status.textContent = record?.statusLabel || (candidates.length ? 'Preview ready. Choose a portrait or edit the prompt to regenerate.' : '');
    }

    function renderPromptOverlay(root = promptOverlay()) {
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        if (!shell) return { positive: '', negative: '', combined: '' };
        if (shell.dataset.generate === 'true') {
            renderGenerationView(root);
            return { positive: readPromptValue('positive', root), negative: readPromptValue('negative', root), combined: combinedPromptValue(root) };
        }
        const npc = findNpcByReference(state(), shell.dataset.npcId || '');
        const presetId = root?.querySelector('#npc_state_v3_prompt_preset')?.value || '';
        const values = npc ? buildPortraitPrompts(npc, portraitPromptSettingsForPreset(getSettings(), presetId)) : { positive: '', negative: '', combined: '' };
        composePromptOverlay(root);
        root?.querySelector('.npc-state-v3-prompt-copy-positive')?.toggleAttribute('disabled', !readPromptValue('positive', root).trim());
        root?.querySelector('.npc-state-v3-prompt-copy-negative')?.toggleAttribute('disabled', !readPromptValue('negative', root).trim());
        root?.querySelector('.npc-state-v3-prompt-copy-both')?.toggleAttribute('disabled', !readPromptValue('positive', root).trim() && !readPromptValue('negative', root).trim());
        updateReferenceNote(root);
        return values;
    }

    async function copyPromptOverlay(channel, root = promptOverlay()) {
        const value = channel === 'negative' ? readPromptValue('negative', root).trim() : channel === 'both' ? combinedPromptValue(root) : readPromptValue('positive', root).trim();
        if (!value) return false;
        await copyText(value);
        notify('success', channel === 'both' ? 'positive and negative portrait prompts copied.' : `${channel} portrait prompt copied.`);
        return true;
    }

    function referenceBase64(dataUrl) {
        return String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    }

    const IMA2_ENDPOINT = '/api/plugins/npc-state-ima2/generate';
    const IMA2_MAX_REF_CHARS = 7 * 1024 * 1024;
    const IMA2_MAX_PROMPT_CHARS = 32000;

    function liveNpcById(npcId) {
        const state = engine.getState?.();
        return (state?.npcs || []).find(npc => npc?.id === npcId) || null;
    }

    function clearProgressToast(record) {
        if (record?.toastHandle && typeof globalThis.toastr?.clear === 'function') {
            globalThis.toastr.clear(record.toastHandle, { force: true });
        }
        if (record) record.toastHandle = null;
    }

    /**
     * Resolves the existing portrait into one Ima2 reference data URL.
     * Data URLs pass through directly; only same-origin /user/images/ files
     * may be fetched. Oversized references are reduced with compressPortrait
     * for provider input only. No silent text-only fallback: failures stop
     * before generation.
     */
    async function prepareReference(source) {
        const reference = String(source || '');
        let dataUrl = '';
        let blob = null;
        if (reference.startsWith('data:')) {
            dataUrl = reference;
        } else {
            let parsed;
            try { parsed = new URL(reference, globalThis.location?.href); } catch { return { ok: false, error: 'the portrait reference URL is invalid.' }; }
            if (!globalThis.location?.origin || parsed.origin !== globalThis.location.origin || !parsed.pathname.startsWith('/user/images/')) {
                return { ok: false, error: 'the portrait reference must be a local SillyTavern image.' };
            }
            let response;
            try { response = await fetch(`${parsed.pathname}${parsed.search}`, { redirect: 'error' }); } catch { return { ok: false, error: 'the portrait reference file could not be read.' }; }
            if (!response?.ok) return { ok: false, error: 'the portrait reference file could not be read.' };
            try { blob = await response.blob(); } catch { return { ok: false, error: 'the portrait reference file could not be read.' }; }
            if (!blob || !String(blob.type || '').startsWith('image/') || /svg/i.test(String(blob.type))) {
                return { ok: false, error: 'the portrait reference is not a supported PNG, JPEG, or WebP image.' };
            }
            try { dataUrl = await imageUtils.getBase64Async(blob); } catch { return { ok: false, error: 'the portrait reference could not be decoded.' }; }
        }
        if (!/^data:image\/(?:png|jpeg|jpg|webp);base64,/.test(dataUrl)) {
            return { ok: false, error: 'the portrait reference is not a supported PNG, JPEG, or WebP image.' };
        }
        if (referenceBase64(dataUrl).length <= IMA2_MAX_REF_CHARS) return { ok: true, references: [dataUrl], reduced: false };
        try {
            const reduced = await compressPortrait(blob || await (await fetch(dataUrl)).blob());
            if (!reduced?.dataUrl || referenceBase64(reduced.dataUrl).length > IMA2_MAX_REF_CHARS) throw new Error('still-too-large');
            return { ok: true, references: [reduced.dataUrl], reduced: true };
        } catch {
            return { ok: false, error: 'the portrait reference exceeds the Ima2 size limit and could not be reduced.' };
        }
    }

    function generationSessionFor(chatKey, npcId) {
        const key = pendingKey(chatKey, npcId);
        const existing = generationSessions.get(key);
        if (existing) return existing;
        const library = normalizePortraitPresetLibrary(getSettings());
        const presetId = library.portraitActivePresetId;
        const values = buildPairFor(npcId, presetId);
        const session = {
            chatKey,
            npcId,
            presetId,
            positive: values.positive,
            negative: values.negative,
            initialPositive: values.positive,
            initialNegative: values.negative,
            candidates: [],
            selectedCandidateId: null,
            invalidated: false,
        };
        generationSessions.set(key, session);
        return session;
    }

    function destroySessionUrls(session) {
        for (const candidate of session?.candidates || []) {
            if (candidate.previewUrl && typeof globalThis.URL?.revokeObjectURL === 'function') {
                globalThis.URL.revokeObjectURL(candidate.previewUrl);
            }
            candidate.previewUrl = null;
            candidate.blob = null;
        }
    }

    function disposeMissingNpcSessions() {
        for (const [key, session] of [...generationSessions]) {
            if (pendingGenerations.has(key)) continue;
            if (!findNpcByReference(state(), session.npcId)) {
                destroySessionUrls(session);
                generationSessions.delete(key);
            }
        }
    }

    function operationStillValid(key, record) {
        if (!record || record.invalidated) return false;
        const session = record.session;
        if (!session || session.invalidated || generationSessions.get(key) !== session) return false;
        if (getChatKey() !== record.chatKey) return false;
        return Boolean(record.npcId && liveNpcById(record.npcId));
    }

    function discardGenerationResult() {
        notify('error', 'Portrait generation was discarded because the chat or NPC changed.');
        return false;
    }

    function discardApplicationResult() {
        notify('error', 'Portrait application was discarded because the chat or NPC changed. The current portrait was preserved.');
        return false;
    }

    async function startGeneration(npcId, root = promptOverlay()) {
        const chatKey = getChatKey();
        if (!chatKey || chatKey === 'no-chat' || /-pending:/.test(chatKey)) {
            notify('warning', 'load a chat before generating a portrait.');
            return false;
        }
        const key = pendingKey(chatKey, npcId);
        if (pendingGenerations.has(key)) {
            notify('warning', 'a portrait operation is already running for this NPC.');
            return false;
        }
        const npc = liveNpcById(npcId);
        if (!npc) {
            notify('error', 'NPC not found in the active dossier.');
            return false;
        }
        const session = generationSessionFor(chatKey, npcId);
        const positive = String(readPromptValue('positive', root));
        const negative = String(readPromptValue('negative', root));
        session.positive = positive;
        session.negative = negative;
        session.initialPositive = positive;
        session.initialNegative = negative;
        if (!positive.trim()) {
            notify('error', 'the positive prompt is blank.');
            return false;
        }
        const prompt = `POSITIVE\n${positive}\n\nNEGATIVE\n${negative}`.trim();
        if (prompt.length > IMA2_MAX_PROMPT_CHARS) {
            notify('error', `the combined prompt is ${prompt.length} characters; Ima2 accepts at most 32,000.`);
            return false;
        }
        const record = {
            chatKey,
            npcId,
            session,
            phase: 'generating',
            statusLabel: 'Generating preview…',
            toastHandle: null,
        };
        pendingGenerations.set(key, record);
        if (globalThis.toastr?.info) {
            record.toastHandle = globalThis.toastr.info(`Generating portrait preview for ${npc.name}…`, 'NPC State', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        }
        syncOpenGenerationDialog(key);
        try {
            let references = [];
            const attachedAtClick = portraitSource(npc);
            if (attachedAtClick) {
                const prepared = await prepareReference(attachedAtClick);
                if (!operationStillValid(key, record)) return discardGenerationResult();
                if (!prepared.ok) {
                    notify('error', `portrait generation stopped before submitting: ${prepared.error}`);
                    return false;
                }
                references = prepared.references;
                if (prepared.reduced) {
                    record.statusLabel = 'Generating preview… (reference copy reduced to fit Ima2 limits)';
                    syncOpenGenerationDialog(key);
                }
            }
            if (!operationStillValid(key, record)) return discardGenerationResult();
            const response = await fetch(IMA2_ENDPOINT, {
                method: 'POST',
                headers: { ...getHeaders(), 'content-type': 'application/json' },
                body: JSON.stringify({ prompt, references }),
            });
            if (response.status === 404) {
                notify('error', 'the Ima2 bridge plugin is not loaded. Install plugins/npc-state-ima2 and restart SillyTavern.');
                return false;
            }
            const data = await response.json().catch(() => null);
            if (!response?.ok || !data?.image) {
                const code = ['IMA2_UNAVAILABLE', 'IMA2_GENERATION_FAILED', 'IMA2_INVALID_IMAGE', 'INVALID_PORTRAIT_REQUEST'].includes(data?.code)
                    ? data.code
                    : response?.status || 'unknown';
                notify('error', `portrait generation failed (${code}). The current portrait was preserved; nothing was attached.`);
                return false;
            }
            if (!operationStillValid(key, record)) return discardGenerationResult();
            let blob = null;
            let size = null;
            try {
                blob = await (await fetch(data.image)).blob();
                size = await imageUtils.getImageSizeFromDataURL(data.image).catch(() => null);
            } catch {
                blob = null;
            }
            if (!blob || !size || Number(size.width) !== Number(data.width) || Number(size.height) !== Number(data.height)) {
                notify('error', 'the generated image could not be previewed. The current portrait was preserved; nothing was attached.');
                return false;
            }
            if (!operationStillValid(key, record)) return discardGenerationResult();
            const previewUrl = globalThis.URL.createObjectURL(blob);
            const currentSession = generationSessions.get(key);
            if (currentSession !== session || session.invalidated) {
                globalThis.URL.revokeObjectURL(previewUrl);
                return discardGenerationResult();
            }
            const candidate = {
                id: String(data.requestId || `candidate-${Date.now()}`),
                blob,
                previewUrl,
                width: Number(data.width),
                height: Number(data.height),
                savedPath: null,
            };
            session.candidates.push(candidate);
            session.selectedCandidateId = candidate.id;
            record.statusLabel = 'Preview ready. Choose a portrait or edit the prompt to regenerate.';
            syncOpenGenerationDialog(key);
            notify('success', `preview ${session.candidates.length} ready (${candidate.width} × ${candidate.height}). Choose a portrait or edit the prompt to regenerate.`);
            return true;
        } catch {
            notify('error', 'portrait generation could not reach Ima2. The current portrait was preserved.');
            return false;
        } finally {
            releasePending(key, record);
            syncOpenGenerationDialog(key);
        }
    }

    function validUploadedPath(value) {
        if (typeof value !== 'string' || !value) return false;
        try {
            const parsed = new URL(value, globalThis.location?.href);
            return Boolean(globalThis.location?.origin) && parsed.origin === globalThis.location.origin
                && parsed.pathname.startsWith('/user/images/npc-state/');
        } catch {
            return false;
        }
    }

    function applyStillValid(key, record) {
        if (!operationStillValid(key, record)) return false;
        const npc = liveNpcById(record.npcId);
        if (!npc) return false;
        const currentPortrait = npc.portrait && typeof npc.portrait === 'object' ? npc.portrait : {};
        if (portraitSource({ portrait: currentPortrait }) !== record.capturedPortraitSource) return false;
        if ((Number(currentPortrait.updatedAt) || 0) !== record.capturedPortraitUpdatedAt) return false;
        return (Number(npc.updatedAt) || 0) === record.capturedNpcUpdatedAt;
    }

    async function applyCandidate(npcId, root = promptOverlay()) {
        const chatKey = getChatKey();
        if (!chatKey || chatKey === 'no-chat' || /-pending:/.test(chatKey)) {
            notify('warning', 'load a chat before applying a portrait.');
            return false;
        }
        const key = pendingKey(chatKey, npcId);
        if (pendingGenerations.has(key)) {
            notify('warning', 'a portrait operation is already running for this NPC.');
            return false;
        }
        const npc = liveNpcById(npcId);
        if (!npc) {
            notify('error', 'NPC not found in the active dossier.');
            return false;
        }
        const session = generationSessions.get(key) || null;
        const selected = session?.candidates.find(candidate => candidate.id === session.selectedCandidateId) || null;
        if (!selected) {
            notify('warning', 'generate a preview before applying a portrait.');
            return false;
        }
        if (selected.savedPath && selected.savedPath === portraitSource(npc)) {
            notify('warning', 'this preview is already the attached portrait.');
            return false;
        }
        const capturedPortrait = npc.portrait && typeof npc.portrait === 'object' ? structuredClone(npc.portrait) : null;
        const capturedPortraitSource = portraitSource({ portrait: capturedPortrait });
        const capturedPortraitUpdatedAt = Number(capturedPortrait?.updatedAt) || 0;
        const capturedNpcUpdatedAt = Number(npc.updatedAt) || 0;
        const record = {
            chatKey,
            npcId,
            session,
            phase: 'applying',
            statusLabel: 'Applying portrait…',
            toastHandle: null,
            candidate: selected,
            capturedPortraitSource,
            capturedPortraitUpdatedAt,
            capturedNpcUpdatedAt,
        };
        pendingGenerations.set(key, record);
        if (globalThis.toastr?.info) {
            record.toastHandle = globalThis.toastr.info(`Applying portrait to ${npc.name}…`, 'NPC State', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        }
        syncOpenGenerationDialog(key);
        let commitAttempted = false;
        try {
            let savedPath = selected.savedPath || '';
            if (!savedPath) {
                const base64 = referenceBase64(await imageUtils.getBase64Async(selected.blob));
                if (!base64) throw new Error('empty-bytes');
                savedPath = await imageUtils.saveBase64AsFile(base64, 'npc-state', `npc-${crypto.randomUUID()}`, 'png');
            }
            if (!applyStillValid(key, record)) return discardApplicationResult();
            if (!validUploadedPath(savedPath)) {
                selected.savedPath = null;
                throw new Error('upload-path');
            }
            const savedSize = await imageUtils.getImageSizeFromDataURL(savedPath).catch(() => null);
            if (!savedSize || Number(savedSize.width) !== Number(selected.width) || Number(savedSize.height) !== Number(selected.height)) {
                selected.savedPath = null;
                throw new Error('upload-verify');
            }
            selected.savedPath = savedPath;
            if (!applyStillValid(key, record)) return discardApplicationResult();
            const portrait = {
                url: selected.savedPath,
                mime: 'image/png',
                sourceName: selected.savedPath.split('/').pop() || 'portrait.png',
                width: Number(selected.width),
                height: Number(selected.height),
                updatedAt: Date.now(),
            };
            commitAttempted = true;
            const update = await engine.updateNpc(npcId, { portrait }, { expectedUpdatedAt: record.capturedNpcUpdatedAt, expectedChatKey: chatKey });
            if (!update?.ok) {
                notify('error', 'the portrait was not applied because the dossier changed. The current portrait was preserved; the candidate is still available.');
                return false;
            }
            syncOpenGenerationDialog(key);
            notify('success', `portrait applied (${portrait.width} × ${portrait.height}).`);
            return true;
        } catch {
            if (commitAttempted) {
                notify('error', 'Could not confirm that the portrait was applied. Candidate kept; reopen the dossier to check before retrying.');
                if (selected.savedPath) showSavedLink(selected.savedPath);
            } else {
                notify('error', 'the portrait could not be uploaded or verified. The current portrait was preserved; the candidate is still available.');
            }
            return false;
        } finally {
            releasePending(key, record);
            syncOpenGenerationDialog(key);
        }
    }

    function showSavedLink(path) {
        if (globalThis.toastr?.info) {
            globalThis.toastr.info(`Uploaded copy: <a href="${escapeHtml(path)}" target="_blank" rel="noopener">${escapeHtml(path)}</a>`, 'NPC State', { escapeHtml: false, timeOut: 15000, closeButton: true });
        }
    }

    function invalidateGenerationContext() {
        for (const record of pendingGenerations.values()) record.invalidated = true;
        for (const session of generationSessions.values()) {
            session.invalidated = true;
            destroySessionUrls(session);
        }
        generationSessions.clear();
        const root = promptOverlay();
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        if (shell?.dataset?.generate === 'true') closePrompt();
    }

    function closePrompt() {
        promptOverlay()?.remove();
        globalThis.document?.documentElement?.classList.remove('npc-state-v3-prompt-open');
        globalThis.document?.body?.classList.remove('npc-state-v3-prompt-open');
        if (promptFocusBeforeOpen && promptFocusBeforeOpen.isConnected === true) {
            try { promptFocusBeforeOpen.focus?.({ preventScroll: true }); } catch { promptFocusBeforeOpen.focus?.(); }
        }
        promptFocusBeforeOpen = null;
    }

    function releasePending(key, record) {
        clearProgressToast(record);
        if (pendingGenerations.get(key) === record) pendingGenerations.delete(key);
    }

    function syncOpenGenerationDialog(key) {
        const root = promptOverlay();
        const shell = root?.querySelector('.npc-state-v3-prompt-shell');
        if (shell?.dataset?.generate !== 'true') return;
        if (sessionKeyForShell(root) !== key) return;
        renderGenerationView(root);
    }

    function openFor(reference, { generate = false } = {}) {
        const npc = findNpcByReference(state(), reference);
        if (!npc || !globalThis.document?.body) return false;
        ensureStyleSheet();
        disposeMissingNpcSessions();
        closePrompt();
        const library = normalizePortraitPresetLibrary(getSettings());
        const overlay = globalThis.document.createElement('div');
        overlay.id = PROMPT_OVERLAY_ID;
        overlay.className = 'npc-state-v3-prompt-overlay';
        overlay.innerHTML = promptOverlayHtml(npc, library, { generate });
        const shell = overlay.querySelector('.npc-state-v3-prompt-shell');
        const chatKey = getChatKey();
        if (shell) {
            shell.dataset.chatKey = chatKey;
            promptFocusBeforeOpen = globalThis.document.activeElement instanceof globalThis.HTMLElement ? globalThis.document.activeElement : null;
        }
        const generationKey = generate && chatKey && chatKey !== 'no-chat' && !/-pending:/.test(chatKey) && npc.id ? pendingKey(chatKey, npc.id) : null;
        if (generate && chatKey && chatKey !== 'no-chat' && !/-pending:/.test(chatKey) && npc.id) {
            generationSessionFor(chatKey, npc.id);
        }
        overlay.addEventListener('click', event => {
            if (event.target === overlay || event.target.closest?.('.npc-state-v3-prompt-close')) closePrompt();
        });
        shell?.addEventListener('keydown', event => { if (event.key === 'Escape') closePrompt(); });
        overlay.querySelector('#npc_state_v3_prompt_preset')?.addEventListener('change', event => {
            const select = event.currentTarget;
            const previousPresetId = select.dataset.previousPresetId || library.portraitActivePresetId;
            if (generate && generationPromptEdited(overlay)) {
                const discard = globalThis.confirm?.('Changing the preset recomposes both prompts and discards your edits. Continue?');
                if (!discard) {
                    select.value = previousPresetId;
                    return;
                }
            }
            if (generate) {
                const session = sessionForShell(overlay);
                if (session) {
                    session.presetId = select.value;
                    composeGenerationPrompt(overlay, session);
                } else {
                    composePromptOverlay(overlay);
                }
            } else {
                composePromptOverlay(overlay);
            }
            renderPromptOverlay(overlay);
            select.dataset.previousPresetId = select.value;
        });
        overlay.querySelector('.npc-state-v3-prompt-copy-positive')?.addEventListener('click', () => copyPromptOverlay('positive', overlay).catch(error => notify('error', error.message)));
        overlay.querySelector('.npc-state-v3-prompt-copy-negative')?.addEventListener('click', () => copyPromptOverlay('negative', overlay).catch(error => notify('error', error.message)));
        overlay.querySelector('.npc-state-v3-prompt-copy-both')?.addEventListener('click', () => copyPromptOverlay('both', overlay).catch(error => notify('error', error.message)));
        if (generate) {
            for (const selector of ['#npc_state_v3_prompt_positive', '#npc_state_v3_prompt_negative']) {
                overlay.querySelector(selector)?.addEventListener('input', () => {
                    const session = sessionForShell(overlay);
                    if (session) {
                        session.positive = readPromptValue('positive', overlay);
                        session.negative = readPromptValue('negative', overlay);
                    }
                    renderPromptOverlay(overlay);
                });
            }
            overlay.querySelector('.npc-state-v3-prompt-generate')?.addEventListener('click', () => {
                startGeneration(npc.id, overlay).catch(() => notify('error', 'portrait generation could not start. The current portrait was preserved.'));
            });
            overlay.querySelector('.npc-state-v3-prompt-apply')?.addEventListener('click', () => {
                applyCandidate(npc.id, overlay).catch(() => notify('error', 'the portrait could not be applied. The current portrait was preserved.'));
            });
        }
        globalThis.document.body.appendChild(overlay);
        globalThis.document.documentElement?.classList.add('npc-state-v3-prompt-open');
        globalThis.document.body.classList.add('npc-state-v3-prompt-open');
        renderPromptOverlay(overlay);
        if (generationKey) syncOpenGenerationDialog(generationKey);
        if (generate && !pendingFor(getChatKey(), npc.id)) {
            const select = overlay.querySelector('#npc_state_v3_prompt_preset');
            if (select) select.dataset.previousPresetId = select.value;
        }
        try { shell?.focus({ preventScroll: true }); } catch { shell?.focus?.(); }
        return true;
    }

    function bindDossierBridge() {
        if (dossierBridgeBound || !globalThis.document?.addEventListener) return false;
        dossierBridgeBound = true;
        globalThis.document.addEventListener('click', event => {
            const generateButton = event.target?.closest?.('.npc-state-v3-generate-portrait');
            if (generateButton) {
                event.preventDefault();
                generateButton.closest?.('details')?.removeAttribute?.('open');
                openFor(generateButton.dataset.npcId || '', { generate: true });
                return;
            }
            const button = event.target?.closest?.('.npc-state-v3-generate-image-prompt');
            if (!button) return;
            event.preventDefault();
            button.closest?.('details')?.removeAttribute?.('open');
            openFor(button.dataset.npcId || '');
        });
        return true;
    }

    function attach() {
        ensureStyleSheet();
        bindDossierBridge();
        if (panel()) return true;
        const settingsPanel = globalThis.document?.getElementById?.('npc_state_settings');
        const drawer = settingsPanel?.querySelector?.('.npc-state-drawer');
        if (!drawer) return false;
        const wrapper = globalThis.document.createElement('div');
        wrapper.innerHTML = sectionHtml();
        const section = wrapper.firstElementChild;
        const actions = drawer.querySelector('#npc_state_v3_main_actions');
        if (actions?.before) actions.before(section);
        else drawer.appendChild(section);
        bind(section);
        draft = savedDraft();
        dirty = false;
        loadDraftFields(section);
        syncNpcChoices(section);
        renderPreview(section);
        return true;
    }

    function refresh() {
        ensureStyleSheet();
        bindDossierBridge();
        if (!attach()) return false;
        const root = panel();
        if (!dirty) {
            draft = savedDraft();
            loadDraftFields(root);
        }
        syncNpcChoices(root);
        renderPreview(root);
        disposeMissingNpcSessions();
        const overlay = promptOverlay();
        if (overlay) {
            const select = overlay.querySelector('#npc_state_v3_prompt_preset');
            const previous = select?.value || '';
            const library = normalizePortraitPresetLibrary(getSettings());
            if (select) {
                select.innerHTML = promptOptionsHtml(library, previous);
                select.value = library.portraitPresets.some(preset => preset.id === previous) ? previous : library.portraitActivePresetId;
            }
            const shell = overlay.querySelector('.npc-state-v3-prompt-shell');
            const key = sessionKeyForShell(overlay);
            if (key && shell?.dataset?.generate === 'true') {
                const session = generationSessions.get(key);
                if (session && !pendingGenerations.has(key) && !library.portraitPresets.some(preset => preset.id === session.presetId)) {
                    session.presetId = library.portraitActivePresetId;
                }
                syncOpenGenerationDialog(key);
            } else if (shell?.dataset?.generate !== 'true') {
                renderPromptOverlay(overlay);
            }
        }
        return true;
    }

    function scheduleMount() {
        ensureStyleSheet();
        bindDossierBridge();
        if (attach()) return true;
        if (mountTimer) return false;
        let attempts = 0;
        mountTimer = setInterval(() => {
            attempts += 1;
            if (attach() || attempts >= 40) {
                clearInterval(mountTimer);
                mountTimer = null;
            }
        }, 500);
        mountTimer?.unref?.();
        return false;
    }

    function buildPairFor(reference, presetId = '') {
        const npc = findNpcByReference(state(), reference);
        const settings = portraitPromptSettingsForPreset(getSettings(), presetId);
        return npc ? buildPortraitPrompts(npc, settings) : { positive: '', negative: '', combined: '' };
    }

    function buildFor(reference, presetId = '') {
        const npc = findNpcByReference(state(), reference);
        const settings = portraitPromptSettingsForPreset(getSettings(), presetId);
        return npc ? buildPortraitPrompt(npc, settings) : '';
    }

    async function copyPositiveFor(reference, presetId = '') {
        const value = buildPairFor(reference, presetId).positive;
        if (!value) return false;
        await copyText(value);
        notify('success', 'positive portrait prompt copied.');
        return true;
    }

    async function copyNegativeFor(reference, presetId = '') {
        const value = buildPairFor(reference, presetId).negative;
        if (!value) return false;
        await copyText(value);
        notify('success', 'negative portrait prompt copied.');
        return true;
    }

    async function copyBothFor(reference, presetId = '') {
        const value = buildPairFor(reference, presetId).combined;
        if (!value) return false;
        await copyText(value);
        notify('success', 'positive and negative portrait prompts copied.');
        return true;
    }

    // Backward-compatible original helper copies the positive channel.
    async function copyFor(reference, presetId = '') {
        return copyPositiveFor(reference, presetId);
    }

    return Object.freeze({
        scheduleMount,
        refresh,
        invalidateGenerationContext,
        openFor,
        closePrompt,
        buildFor,
        buildPairFor,
        copyFor,
        copyPositiveFor,
        copyNegativeFor,
        copyBothFor,
        get dirty() { return dirty; },
    });
}
