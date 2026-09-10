# NPC State v0.3.2

> **Fork notice.** This is `disreconnected/npc_state`, a maintained fork of
> [`kohz87/npc_state`](https://github.com/kohz87/npc_state). It preserves upstream
> history and attribution and adds a local Ima2 portrait generation bridge plus
> the portrait preview/apply workflow. Fork maintainer: `disreconnected`.
> The repository declares no license of its own; upstream has no declared
> license, so original author rights and notices are unchanged.

NPC State v0.3 is the current SillyTavern narrated-NPC dossier tracker. The repository root is now v0.3-only. The complete v0.2.x line is frozen under [`legacy/v0.2.x/`](legacy/v0.2.x/) for reference and recovery, and no legacy runtime file is loaded by the root extension manifest or bootstrap.

## Install / update in SillyTavern

This repository supplies **two independent entrypoints** from the same commit:

| Role | Entry | Where SillyTavern loads it from |
| --- | --- | --- |
| Frontend extension | `manifest.json`, `bootstrap.js`, `v03/index.js` | `<ST>/public/scripts/extensions/third-party/npc_state` |
| Server plugin (Ima2 bridge) | `package.json` `main` -> `index.mjs` | `<ST>/plugins/npc-state-ima2` |

The frontend never imports `index.mjs`, and the server plugin never loads `bootstrap.js`.

Install or replace the frontend extension:

```bash
git clone https://github.com/disreconnected/npc_state.git "<existing NPC State path>"
```

Or, for a fresh install with no existing NPC State checkout, use SillyTavern's
**Extensions -> Install Extension** flow with the repository URL:

```text
https://github.com/disreconnected/npc_state
```

Do **not** use that Extensions UI to install over a folder that already exists:
the endpoint returns 409. Replace an existing checkout with the `git clone` above.

Install or replace the server plugin from the SillyTavern root:

```bash
git clone https://github.com/disreconnected/npc_state.git plugins/npc-state-ima2
```

There must be exactly one plugin advertising `npc-state-ima2`. SillyTavern's own
plugin loader resolves `package.json` `main`, so the identical repository works
in both locations without a shim. See
[Ima2 portrait generation](#ima2-portrait-generation) for the one-time local runtime setup.

SillyTavern installs the repository's default branch. `main` is the supported v0.3
line, so a normal install or Extension Manager update uses the root `manifest.json`
(`0.3.2`) and `bootstrap.js`, which load only the supported v0.3 runtime.

A frontend Extension Manager update alone does **not** update the server plugin.
Update both checkouts explicitly; see
[Updating](#updating-both-checkouts).

## What changed

v0.3 replaces the layered scan/backfill system with one explicit current-cast transaction. The scanner keeps three concepts separate:

- **Exchange active**: the NPC spoke, acted, was directly acted upon, or directly perceived/received a relevant event in the current user + assistant exchange.
- **Present**: the NPC is physically present at the end of the latest assistant scene.
- **World active**: the NPC is explicitly active off-screen.

The full reconciliation target is exactly:

```text
exchange active NPCs + final physically present NPCs
```

Off-screen world-active NPCs may receive grounded live-state updates such as location, status, or an explicit death/return, but they do not enter full profile/relationship reconciliation merely for being active elsewhere.

## Core v0.3 guarantees

- One batch model call for the normal current-cast scan, rather than an automatic per-NPC backfill forest.
- Relationship deltas use current-exchange evidence only. Older context can recover stable profile facts and durable memories, but cannot replay relationship changes.
- Strict final-scene physical presence controls inline cards and generation injection.
- Important memories, key relationships, mannerisms, and behavioral profile are bounded **evolving collections** rather than append-only logs. The scanner preserves an untouched collection, but when canon changes it may rewrite, merge, retire, reorder, or replace entries to keep the strongest current set.
- Dossier Evolution settings control the working caps for those four collections. Defaults remain 5 important memories, 12 key relationships, 8 mannerisms, and 8 behavioral-profile entries, with guarded configurable ceilings of 20, 30, 16, and 16 respectively.
- Lowering a working cap does not destructively trim stored dossier data during ordinary normalization. The lower cap takes effect when that collection is next deliberately curated by the scanner or manually saved; raising a cap can genuinely persist additional entries up to the storage safety ceiling.
- The player/persona has one dedicated relationship channel: trust, affection, desire, tension, relationship summary, and current-exchange relationship change. `keyRelationships` and social edges are reserved for non-player ties.
- Apparent age is canonicalized to one approximate numeric value such as `~25`; vague decade bands or ranges are not stored as apparent age.
- When the latest assistant message contains a Megumin master block, the same present-NPC roster mounts as an **NPC State** tab inside that block. If Megumin is absent or its tab hosts are unavailable, NPC State keeps its normal standalone inline roster.
- The Megumin bridge is UI-only. NPC State does not depend on Megumin-owned state, persistence, scanning, or dossier logic; generated World State text remains ordinary chat context for the normal v0.3 scanner.
- Stale NPC lifecycle is based on **narrative assistant turns**, not scan count. Re-running a scan on the same assistant message cannot age a dossier.
- Default stale thresholds are 30 inactive narrative turns to archive and 50 total inactive narrative turns to remove a stale archive. These values are configurable in NPC State settings.
- Being off-screen is not itself a stale event. Current interaction, final physical presence, explicit off-screen world activity, or a canonical-name/alias reference in the current exchange resets the inactivity timer.
- A stale-archived NPC that becomes narratively active again is restored automatically. Manual archives and deceased archives are never auto-deleted by stale management.
- `Retention protected` dossiers and dossiers with manual stable-profile locks are hard-shielded from automatic stale archive/delete.
- Automatic stale cleanup is intentionally softer than explicit manual Delete: it removes the dossier and its structured social edges but does not create a permanent deletion tombstone, allowing genuine later re-admission or branch recovery.
- A dedicated **Review stale NPCs** surface keeps manual Open dossier, Reset activity, Protect, Archive/Restore, and explicit Delete controls available.
- Bundle export uses an explicit portable v0.3 format instead of copying the raw sidecar. Full-chat backup preserves normalized dossiers, memories, relationships/history, social graph, portraits, suppression names, tombstones, archive/retention/stale fields, and stable IDs.
- Selected-NPC export contains one normalized dossier plus social edges touching that stable ID. Edges whose counterpart does not exist in the destination are dropped safely during import.
- Bundles never carry branch checkpoints/baselines/lineage, latest observation state, sidecar revision bookkeeping, migration state, or in-process operation locks.
- Bundle imports are parsed, schema-checked, identity-validated, and normalized before commit. Unknown dossier fields are dropped by the v0.3 whitelist schema rather than written through raw.
- Safe merge defaults to keeping current data for matching stable IDs and aborting on hard stable-ID/name or tombstone conflicts. The UI can instead use imported data for matching IDs or skip conflicting imported identities.
- Full-chat **Replace durable state** is a separate explicit restore mode. It replaces portable dossier/social/tombstone domains but keeps the destination chat's branch/runtime machinery local and clears imported live presence.
- Cross-chat bundle imports clear source-chat message IDs, preserve relative stale age by rebasing `lastActivityTurn`, and never import source live presence.
- Portrait prompt support is settings-only and local. It stores a named library of reusable positive/negative preset pairs, one default preset selection, shared positive/negative prompt templates, and Natural/Tags/Hybrid formatting for the dossier-derived `{{character}}` placeholder.
- Existing single portrait-preset settings become the first named `Default` preset automatically. Saving the portrait settings materializes the named preset library without losing the prior positive or negative text.
- The canonical dossier **More** menu exposes manual **Attach/Change/Remove portrait** controls plus **Generate image prompt**. Prompt generation opens a per-NPC positive/negative prompt composer; portrait attachment remains local and does not require an image API.
- Portrait prompt preview/copy does not call an image API, generate images, create queues, or add portrait lifecycle state.
- The canonical Dossier Library is portrait-first: the selected NPC receives the dominant portrait hero while the full cast remains accessible through a searchable horizontal portrait rail at the bottom of the viewer.
- The Dossier Library has no permanent cast sidebar. Present, world-active, ordinary off-screen, and archived dossiers remain in the same library and are visually distinguished in the cast rail.
- Desktop and landscape tablet keep the portrait pane visible while the dossier document scrolls independently. Portrait tablet and phone layouts stack the portrait hero over a single readable document column while retaining the bottom cast rail.
- The dossier editor uses the browser top layer on supported clients so tablet/mobile editing is not trapped behind SillyTavern stacking contexts. Small-screen editing is top-anchored and scrollable while desktop retains the centered editor.
- Current state, player relationship, personality, appearance, behavior, speech, mannerisms, memories, key relationships, background, and relationship history are rendered as distinct visual blocks rather than one continuous text document.
- One canonical dossier detail surface is used by the library, settings roster, stale review, and inline present cards.
- Background/model operations never save editor DOM state. Editor saves are identity-bound and use an optimistic `updatedAt` guard so a stale form cannot overwrite newer scan data.
- Manual deletion creates a stable-ID tombstone. Branch rollback cannot resurrect that deleted identity.
- Scanner output cannot recreate a tombstoned stable ID or retarget an existing same-name dossier with an invented ID.
- Per-chat model operations are serialized. A new user message invalidates an in-flight scan, and a late result is discarded before state commit.
- Automatic scanning honors the global Enable setting. Manual dossier tools remain available while disabled.
- v0.3 sidecars use revision checks, a cross-tab writer lock, and a local pointer hint so a stale tab cannot overwrite the first v0.3 write.

## Dossier Library UI

The canonical Dossier Library is built around the selected character rather than a permanent navigation column.

On desktop, the viewer uses a portrait-heavy split layout:

```text
┌─────────────────────────────┬──────────────────────────────────────┐
│                             │ CURRENT                              │
│                             │                                      │
│                             │ RELATIONSHIP WITH PLAYER             │
│        LARGE PORTRAIT       │                                      │
│                             │ PROFILE BLOCKS                       │
│                             │ Personality     Appearance           │
│                             │ Behavior        Speech               │
│                             │ Memories        Relationships        │
│ Name / identity / state     │ Background      History              │
│ Edit / Refresh / More       │                                      │
├─────────────────────────────┴──────────────────────────────────────┤
│ DOSSIER LIBRARY  [Search]                                           │
│ ◀ [portrait] [portrait] [SELECTED] [portrait] [portrait] [portrait] ▶│
└─────────────────────────────────────────────────────────────────────┘
```

The bottom cast rail:

- contains every stored dossier, including off-screen and archived NPCs;
- prioritizes present NPCs, then world-active NPCs, then ordinary active dossiers, with archived dossiers after them;
- supports name, alias, role, species, and lifecycle-state search;
- supports touch swiping, native horizontal scrolling, and previous/next controls;
- automatically centers the selected stable ID when switching dossiers;
- uses portrait cards with lifecycle status instead of a permanent text sidebar.

An explicit open from Present NPCs, stale review, or another NPC State surface clears a stale library search so the requested dossier cannot be hidden by an old filter. Background refreshes of the same selected NPC preserve the dossier document's scroll position.

Tablet and mobile use the same canonical markup. Landscape tablets retain the split portrait/document view. Portrait tablets and phones turn the dossier into one vertical reading surface with a large portrait hero at the top, while the cast rail remains available at the bottom of the modal.

## Bundle import / export

The **Bundle import / export** section in NPC State settings supports:

- **Export full chat** for a portable durable backup.
- **Export selected NPC** for one dossier plus directly touching social edges.
- **Safe merge** into the current chat.
- **Replace durable state** from a full-chat bundle.
- Matching-ID policy: keep the current dossier or use the imported dossier.
- Hard-conflict policy: abort the entire import or skip conflicting imported identities.

Imports are previewed before confirmation. A rejected preview or conflict performs no sidecar write. Successful import is committed through the normal serialized engine as one sidecar revision and receives a v0.3 branch checkpoint in the destination chat.

Safe merge treats local manual-deletion tombstones as authoritative and will not silently resurrect those IDs. Likewise an imported tombstone cannot silently delete a live local dossier; that is surfaced as an identity conflict. Full-chat Replace is the deliberate escape hatch when the user genuinely intends to restore the bundle's durable state wholesale.

## Portrait prompt

The **Portrait prompt** section in NPC State settings manages the reusable prompt library. It stores:

- **Character formatting**: `Natural`, `Tags`, or `Hybrid`.
- Up to 32 named **portrait presets**, each with a reusable **positive** channel and **negative** channel.
- One **default preset** used by the prompt APIs and initially selected in the dossier prompt dialog.
- One shared **positive prompt template**.
- One shared **negative prompt template**.

Conceptually the saved settings are:

```text
portraitPresets[]
├─ id
├─ name
├─ positive
└─ negative

portraitActivePresetId
portraitPositivePrompt
portraitNegativePrompt
```

The preset library provides **New**, **Duplicate**, **Delete**, rename, and default-selection controls. Positive/negative templates are deliberately shared across presets: presets supply reusable style/exclusion text, while the templates define the common recipe that combines those presets with dossier facts.

The default templates are:

```text
POSITIVE
{{positivePreset}}
{{character}}

NEGATIVE
{{negativePreset}}
```

`{{character}}` is built from the selected dossier according to the formatting mode. The rest of either template remains under user control. Available placeholders include:

```text
{{positivePreset}} {{negativePreset}} {{character}} {{name}} {{aliases}}
{{role}} {{species}} {{age}} {{apparentAge}} {{appearance}} {{personality}}
{{behaviorProfile}} {{speech}} {{mannerisms}} {{background}} {{mood}}
{{location}} {{goal}} {{status}}
```

The legacy `{{portraitPreset}}` placeholder remains accepted as an alias for the positive preset so prompts saved during the first lightweight portrait-prompt pass continue to resolve safely.

Unknown placeholders remain visible instead of silently disappearing, making template typos easy to spot. Missing dossier fields resolve empty; NPC State does not invent portrait facts. An intentionally blank preset or template remains blank rather than being repopulated with a default.

Existing users with only the original single positive/negative pair are migrated non-destructively: that pair is exposed as the first named **Default** preset. No manual conversion is required.

Edits are kept as a local draft until **Save portrait prompt settings** is pressed. The settings panel provides a dossier selector, live positive and negative previews, and controls to copy the positive prompt, negative prompt, or both.

The canonical dossier also exposes **More -> Generate image prompt**. That opens a focused prompt dialog for the selected NPC. The dialog can switch among any saved presets locally, shows the resolved positive and negative channels, and can copy either channel or both. Choosing a preset in this dialog does not change the saved default preset.

Upstream v0.3 had no automatic portrait generation, provider/API integration,
regeneration workflow, request queue, image polling, or portrait-generation state
machine. This fork adds exactly one generation path on top of that surface: the
**local Ima2 bridge** described in [Ima2 portrait generation](#ima2-portrait-generation).
Generation still happens only when the user presses **Generate** in the dossier
prompt dialog; results are held as preview candidates and are written to the NPC
only on an explicit **Apply**. Nothing in the settings surface generates images.

## Ima2 portrait generation

The fork adds a server-side bridge (`index.mjs`) that turns the dossier prompt
dialog into a real generator, using a **local** Ima2 runtime on the same machine.
The bridge calls the fixed loopback route `/api/plugins/npc-state-ima2/generate`.
It does not take a provider, model, host, or port from the client, and the client
cannot make it reach anywhere other than the local runtime it discovers.

Generated images are *candidates*. They are shown in the prompt strip and are not
attached to the NPC, not uploaded, and not persisted until the user presses
**Apply**.

The bridge validates the response: the runtime must echo the exact fixed
generation settings (`gpt-5.6-sol`, `high`, `max`, `2160x3840`, `low`), and the
returned bytes must decode as a real PNG with positive dimensions. The image is
never resized or re-encoded. Candidates carry the dimensions the runtime actually
returned, and the browser re-checks the decoded size of the stored copy at apply
time: a mismatch is rejected and the currently attached portrait is left
untouched. The bridge does not additionally assert that the PNG measures exactly
`2160x3840`; if the local runtime misbehaves, that surfaces as an unexpected
candidate size rather than as a blocked generation.

### Prerequisites

- Known source environment: SillyTavern 1.18.0, NPC State 0.3.2, Ima2 3.16.0.
  `manifest.json` requires a minimum client of 1.18.0. Later SillyTavern versions
  are not automatically certified.
- Git, Node >= 22, and npm on the destination machine.
- Ima2 must run on the **same machine and under the same OS user / default home
  as the SillyTavern server**. A browser on a laptop talking to a remote server
  does not qualify; the bridge discovers a local runtime file.
- An admin account is required when SillyTavern accounts are enabled. The bridge
  route sits behind SillyTavern's normal admin middleware; nothing here weakens
  admin authorization, CSRF, authentication, or host/network protections.
- This is the same 0.3.2-derived runtime described above, not a merge with an
  unknown newer or different fork. **Back up custom code and normal SillyTavern
  data before switching.** If you are running a different customized build,
  compare it separately instead of overwriting it.

### Migrating an existing NPC State installation

1. Stop SillyTavern normally and close its browser tabs. Find the checkout that is
   actually enabled: global installs usually use
   `public/scripts/extensions/third-party/npc_state`, per-user installs can differ.
   Keep the **same location and folder name** so this is a replacement, not a
   second enabled extension.
2. Back up that entire checkout, the destination `config.yaml`, and any existing
   `plugins/npc-state-ima2` folder to a location **outside** every scanned
   extension/plugin directory. Move the old code checkouts there so the install
   paths are vacant. Do not delete them, and do not discard uncommitted changes.
   Do not touch chat data, sidecars, settings, portraits, or credentials.
3. Clone the fork into the original frontend location:

   ```bash
   git clone https://github.com/disreconnected/npc_state.git "<existing NPC State path>"
   ```

4. From the destination SillyTavern root, clone the server plugin:

   ```bash
   git clone https://github.com/disreconnected/npc_state.git plugins/npc-state-ima2
   ```

   There must be exactly one plugin advertising `npc-state-ima2`.
5. For a brand-new install with no frontend checkout, SillyTavern's **Extensions ->
   Install Extension** can use `https://github.com/disreconnected/npc_state` instead
   of step 3. Do not use that UI over an existing same-name folder: the endpoint
   returns 409.

### One-time local runtime setup

- In the destination's own config, set `enableServerPlugins: true`. Stock
  SillyTavern defaults this to `false`. This is a global switch: review the other
  installed plugins before enabling it.
- For synchronized manual updates, set `enableServerPluginsAutoUpdate: false`.
  This is also a **global** switch and affects other plugins too. The alternative
  is to accept independent auto-updates deliberately; the two checkouts are not
  updated atomically.
- Install the known generator build, skipping if that version is already present:

  ```bash
  npm install -g ima2-gen@3.16.0
  ima2 doctor --installation
  ```

  `ima2 doctor --installation` checks the package and native bindings offline.
  If it reports permission failures, fix them with a normal user-writable Node/npm
  setup. Do not use `sudo`, do not `@latest`, and do not copy Windows native
  modules between machines.
- Run `ima2 setup`, choose GPT OAuth, and complete the local interactive login and
  provider approvals yourself. Never transfer tokens or `.ima2/server.json`
  between machines.
- Run `ima2 serve` and leave that terminal open. Start SillyTavern separately with
  its normal launcher — Windows `Start.bat` (PowerShell `.\Start.bat`),
  macOS/Linux `bash start.sh` — from the SillyTavern directory. Then hard-reload or
  reopen the browser.

Later sessions need `ima2 serve` plus a normal SillyTavern start. They do not need
a repeated package install or login. No service, daemon, or custom launcher is added.

### Readiness and troubleshooting

- `ima2 ping --json` performs health checks without generating anything. Confirm
  the local runtime is healthy and `runtime.oauth.status` is `ready`.
- The bridge reads `<home>/.ima2/server.json` to discover the real port and checks
  `runtime.backend.actualPort`. Do not hardcode `3333`, and do not carry paths from
  another machine.
- Custom homes/storage locations or a remote `IMA2_SERVER` override are not a
  supported substitute for the local runtime the bridge discovers. There is no
  networking fallback for those setups.
- SillyTavern startup should log
  `Initializing plugin from .../plugins/npc-state-ima2/index.mjs` with no later
  loading failure. Then:
  - missing route -> check plugin placement, `enableServerPlugins`, and restart;
  - 403 -> admin authorization;
  - `IMA2_UNAVAILABLE` -> inspect the local runtime, OAuth status, and home path;
  - `IMA2_INVALID_IMAGE` -> the fixed output contract was not met. That is a
    runtime/provider problem, not permission to relax the contract.

### Updating both checkouts

Stop SillyTavern before updating. In **both** checkouts run `git pull --ff-only` on
`main`, then compare `git rev-parse HEAD` in both directories and restart only when
they match. If they differ because a new commit landed between the two pulls, fetch
the lagging clean checkout and fast-forward it to the already-fetched newer commit,
then compare again. If either checkout is dirty or diverged, stop and preserve its
work instead of forcing or resetting it. A frontend Extension Manager update alone
does not update the bridge.

The initial public distribution is tag `ima2-preview-1`. Keep the previous working
commit and the backups above for rollback, and restore code plus the prior relevant
config values — not user data. Keep backups outside scanned roots so no duplicate
extension or plugin loads.

### Optional functional check

On the new machine you can generate one preview, confirm that nothing is attached
before you press **Apply**, then apply the selected candidate. This spends provider
quota, and it is entirely user-initiated; nothing in the build or installation flow
runs it.

## v0.2 data migration

When a chat has no v0.3 sidecar but does have a v0.2 sidecar pointer, v0.3 reads the old file once and writes an independent v0.3 sidecar.

Imported durable data includes current NPC dossiers, portraits, relationship values/history that fit the new schema, memories, archive/life state, deletion tombstones, and representable social edges.

Intentionally **not** imported:

- pending backfill/runtime queues
- v0.2 scan locks or transient operation state
- v0.2 branch checkpoints

The original v0.2 sidecar is never rewritten by v0.3.

### Branch boundary after migration

The first v0.3 load establishes a v0.3 branch baseline. Branch edits after that point can restore from v0.3 checkpoints.

If a chat is changed or truncated **before** the oldest recoverable v0.3 checkpoint, NPC State cannot truthfully reconstruct the removed timeline. v0.3.2 therefore pauses strict live presence, scanning, and injection but keeps durable dossiers intact and marks the chat **Timeline rebase required**. Returning to a compatible branch restores checkpoint recovery automatically. If the surviving chat is intentionally the new canon, **Rebase to current chat** preserves durable dossiers, portraits, relationships, memories, manual locks, archives, social ties, tombstones, and relative stale age while clearing chat-local message references, live presence, and incompatible branch checkpoints before establishing a fresh baseline and force-scanning the latest surviving assistant exchange. Facts learned only from deleted messages may remain until later scans revise them or they are edited manually.

## Repository layout

```text
manifest.json        supported extension manifest (v0.3.x)
bootstrap.js         loads only the v0.3 runtime
index.mjs            server plugin entry (Ima2 bridge); loaded by ST's plugin loader
index.test.mjs       bridge integration tests (installed plugin-root layout)
package.json         test:bridge (explicit) + test (release gate); main = index.mjs
v03/                 supported runtime
  index.js
  engine.js
  scanner.js
  schema.js
  branches.js
  storage.js
  migrate-v02.js
  injection.js
  ui.js              canonical UI orchestration and dossier actions
  dossier-view.js     portrait-first dossier, cast rail, search/sort rendering
  megumin.js          UI-only Megumin master-block tab adapter
  stale.js            narrative-turn stale lifecycle and reporting
  stale-ui.js         settings and manual stale-review surface
  bundle.js           portable v0.3 bundle validation/export/import logic
  bundle-ui.js        full-chat/selected-NPC bundle management surface
  portrait-prompt.js  positive/negative prompt composition + named preset library
  portrait-ui.js      preset manager, preview/copy, dossier prompt dialog, and
                      the Ima2 preview-candidate workflow
  portrait-workflow.css portrait settings/dialog layout loaded by portrait-ui.js
  identity.js
  style.css
tests/               v0.3 behavioral release gate
  NpcPortraitPreview.e2e.js  browser regression check for the preview/apply flow
  portrait.playwright.config.js  isolated Playwright config for that check
docs/                v0.3 architecture documentation
legacy/
  README.md
  v0.2.x/            exact frozen v0.2.23 repository snapshot
```

Nothing under `legacy/` is imported by the supported extension runtime.

## Current rewrite scope

The v0.3.2 rewrite now covers the durable core and planned management surfaces: persistence, migration, current-cast scanning, relationship/memory reconciliation, configurable self-curating dossier collections, strict presence, branch checkpoints, prompt injection, the portrait-first responsive canonical dossier library and bottom cast rail, manual editing, archive/restore/delete, inline present cards, a UI-only Megumin master-block/tab mount, narrative-turn stale NPC lifecycle management with manual review controls, validated portable bundle import/export for full-chat and selected-NPC workflows, and lightweight named positive/negative portrait-preset composition with local preview/copy and a per-dossier prompt dialog.

The upstream v0.3 core retains no automatic portrait generation or image-provider
integration. This fork adds one deliberate exception, scoped to a local runtime:
the server plugin `index.mjs` proxies generation to a loopback Ima2 install, and
`v03/portrait-ui.js` turns the response into preview candidates that the user
applies explicitly. No hosted API, key management, or cloud fallback is added.

## Development

```bash
npm install          # dev dependency: @playwright/test (browser checks only)
npm test             # v0.3 behavioral release gate
npm run test:bridge  # Ima2 bridge integration tests
npm run test:portrait # portrait preview/apply browser regression check
```

`npm test` is the release gate and runs only `tests/v03-*.test.js`.

`npm run test:bridge` runs `index.test.mjs`. That file imports `../../src/users.js`,
so it resolves **only** when the repository sits at `<ST>/plugins/npc-state-ima2`
next to a SillyTavern checkout, and it reads the host config path. It does not run
in a standalone frontend checkout; use it from an installed plugin root.

`npm run test:portrait` needs `npx playwright install chromium` once. Its fixture
serves the runtime files straight out of this repository's own `v03/` directory and
aborts every other request, so it needs **no** running SillyTavern, no provider,
and no network. `npm install` and the browser download are developer-only: a
production install clones the repository and never needs either.

Historical v0.2 source, tests, reports, and documentation live only under
`legacy/v0.2.x/` and do not define the v0.3 architecture.
