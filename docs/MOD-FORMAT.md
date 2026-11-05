# Mod format

This document describes how a mod is laid out, how the loader treats it, and what a mod may
touch. It is written for the mod author. Paths are the macOS ones: mods home `~/.omo/app-mods`,
state directory `~/Library/Application Support/omo-app-mods` (override: `LOADER_STATE_DIR`).

## 1. mod.json

A mod is one folder `<modsRoot>/<id>/` with a `mod.json` at its top. The folder name must equal
`id`. `modsRoot` is the parent of the `_loader` folder in an installed copy (`MODS_HOME`), and
`REPO/mods` when the loader runs from the repository.

```json
{
  "id": "sample",
  "name": "Sample",
  "nameKo": "프로필",
  "descriptionKo": "역할별 모델 프로필을 고르고 고치는 화면",
  "version": "0.1.0",
  "enabled": true,
  "order": 10,
  "entry": { "page": "page.js", "css": "page.css", "host": "host.mjs" },
  "contributes": { "settingsPage": { "id": "sample", "label": "프로필" } },
  "update": { "repo": "/Users/me/src/sample-mod", "subdir": "mods/sample" },
  "anchors": [
    { "selector": "#root", "route": "*" },
    { "selector": "[data-settings-nav-path]", "route": "/settings/" }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string | lowercase letters, digits and dashes; equals the folder name |
| `name`, `nameKo`, `version` | string | non-empty |
| `descriptionKo` | string | optional; the one-line Korean description shown in Settings > 모드 |
| `enabled` | boolean | `false` means never injected (reason `DISABLED`); see section 2 for when a change takes effect |
| `locked` | boolean | optional, default `false`; a locked mod is always injected whatever `enabled` says, and `setEnabled` refuses it (`LOCKED`). Only the built-in `modmgr` sets it |
| `order` | integer | injection order; ties break by `id` |
| `entry.page` | string | relative path inside the mod folder; required |
| `entry.css` | string | optional, relative path inside the mod folder |
| `entry.host` | string | optional, relative path inside the mod folder; an ES module |
| `contributes.settingsPage` | object | optional; `{id, label}` |
| `testedBuilds` | string[] | optional; informational only, it never changes whether the mod attaches |
| `update` | object | optional; `{repo, subdir?}`, absolute repository path and the mod folder inside it. Used by the update check when the install manifest has no source for this mod (see [UPDATE.md](../UPDATE.md)) |
| `anchors` | array | `{selector, route}`; the places where the mod attaches |

A path that leaves the mod folder (absolute, or containing `..`) is refused. A mod that fails
the format check is skipped and reported with its reason; the other mods still load.

### Comparison with a VS Code extension manifest

| VS Code `package.json` | omo mod.json | Note |
|---|---|---|
| `name`, `displayName`, `version` | `id`, `name`/`nameKo`, `version` | `id` is also the folder name |
| `main` / `browser` entry | `entry.page` (+ `entry.host`) | the page runs in an isolated world, not in the app's main world |
| `activationEvents` | `anchors` + `route` | a mod runs where its anchors exist, not on a global event |
| `contributes` | `contributes.settingsPage` | only the settings page is a contribution point today |
| `engines.vscode` | `anchors` | compatibility is decided on screen by the anchors, not by a version range |
| `enabledApiProposals` | none | no proposals; the bridge is the only extra API |

If you want to propose an "extension mode" to a developer, the mapping above is the starting
point.

## 2. Lifecycle

1. **Discover.** `loader/mods.mjs` reads `<modsRoot>/*/mod.json` (skipping `_loader`) and sorts by
   `order`, then `id`. Broken entries go to the notice with a reason.
2. **Anchor check.** The loader fingerprints the installed app (`loader/fingerprint.mjs`, reading
   `/Applications/OmO.app/Contents/Resources`) for the state file and logs. For each mod and each anchor that applies to the current route, the loader checks
   that the anchor element is present (waiting up to 5 seconds per route change).
   - An anchor missing: that mod alone is switched off, reason `ANCHOR_MISSING`.
   - All anchors present: attached, no reason. The build key plays no part.
3. **Inject.** The loader attaches to the main window only (`mainTarget` in `docs/app-facts.json`,
   `omo://app/`), and runs one bundle in the isolated world `omo-mods`. The bundle contains the
   route and evaluation functions copied from `mods.mjs`, the page runtime, and each mod's page
   script. The main world of the app does not receive mod code and gets no globals. A host call that fails before the host loads (no `entry.host`, or the module cannot load) switches that mod off with reason `HOST_FAILED` in `status --json`.
4. **Re-inject.** On every document load and every in-page route change the loader runs the
   version and anchor checks again and shows or hides each mod's own roots. A mod's page script
   runs once per document, not once per route.
5. **Watchdog.** An uncaught error in mod code, or an empty `#root` after load, sends
   `__watchdog`. The loader removes the bundle and reloads the page without mods, at most three
   times per target. After that it only shows the notice (reason `WATCHDOG`).
6. **Switch on or off.** `enabled` is read when the mods are resolved: at launch and on every
   `__reload`. Settings > 모드 writes it through `setEnabled`. [지금 새로 고침] asks first, then sends
   `__reload`: the loader reads the mods again, swaps the registered bundle in every attached window,
   and reloads those windows. Without it, the change applies at the next launch.
7. **Exit.** The helper watches the browser socket. When the socket closes, it ends with code 0
   (`OMO_GONE`) if the app process is gone, or code 5 (`ENDPOINT_LOST`) if the app is still
   running but its debug endpoint does not answer. It reconnects at most once per poll interval
   while the app is alive. It never closes or signals the app.

## 3. Bridge API

Page script (isolated world), called as `function (omoMods) { ... }`:

| Member | Behaviour |
|---|---|
| `omoMods.call(method, args)` | Promise. Calls the mod's host module. Rejects with `BRIDGE_TIMEOUT` after 30 s; a banner `bridge-lost` is shown. |
| `omoMods.onTrusted(element, fn)` | runs `fn` only on a real user click (`event.isTrusted`) |
| `omoMods.omoProfile` | the `OMO_PROFILE` value seen by the loader, or `null`; read only |
| `omoMods.forMod(id)` | returns the same `call` and `onTrusted`, bound to a mod id |

Host module (`entry.host`): an ES module that exports `handle(method, args)`. A resolved value is
returned to the page as `{ok: true, value}`; a throw is returned as `{ok: false, error}`.
Method names match `[A-Za-z][A-Za-z0-9_.]{0,63}`. `args` is an array whose JSON is at most 64 KB.
Requests are refused for an unknown mod id, a malformed body, or a reserved control name
(`__plan`, `__fail`, `__watchdog`, `__reload`), which only the page runtime may send.
`__reload` takes no host: the loader resolves the mods again, replaces the registered bundle in each
attached window and reloads it.

modmgr host methods (Settings > 모드):

| Method | Behaviour |
|---|---|
| `list()` | `{ok, mods}`: one row per installed mod with `id`, `nameKo`, `descriptionKo`, `enabled`, `locked`, a Korean `status` (`붙음`, `꺼짐`, `못 붙음`, ...) from the loader's last `state.json`, and `expected` (sha256 of its `mod.json`) |
| `setEnabled({id, on, expected})` | changes only the `enabled` value of one unlocked `mod.json`, after a backup to `<mods-home>/_loader/backups/<time>/<id>-mod.json`. Refusals: `LOCKED`, `STALE` (the file changed since `list`), `UNKNOWN_MOD`, `BAD_ARGS`, `BAD_FORMAT` |
| `checkUpdates()` | `{ok, items}`: per installed id, `installedHash`, `sourceHash`, `changed`, `error` (`NO_SOURCE`, `SOURCE_MISSING`, `READ_FAILED`). Refusal `NO_MANIFEST` |
| `applyUpdates({ids, pull})` | copies the changed sources in (optionally `git pull` first); `{ok, applied, skipped, errors}`. Refusals `NO_MANIFEST`, `BAD_ARGS` |

Mod DOM rules: every element the mod creates lives under `[data-omo-mod-root="<id>"]`, and its
style carries `data-omo-mod="<id>"`. The loader hides these when the anchors are missing. Mods do
not move, replace or clone the app's nodes.

## 4. Security model

- **Debug port.** The app opens a Chromium remote-debugging endpoint only when it is launched
  through `OmO Mods.app` (the loader). The loader passes `--remote-debugging-address=127.0.0.1` and an
  ephemeral port in `OMO_DESKTOP_REMOTE_DEBUGGING_PORT`. The port is not in the normal launch
  environment.
- **Binding only.** The loader listens on loopback. It does not expose an HTTP server of its
  own: the only traffic is the loader's outbound CDP connection to the app's own endpoint.
- **No HTTP.** The loader serves nothing. Its only inbound channel is the page-to-loader binding
  `__omoModsCall`, which exists only in the `omo-mods` isolated world.
- **Home guard.** The loader refuses to start the app (exit 4, no spawn) if the process home is
  redirected away from the real account folder, or if an agent-directory variable points somewhere
  else.
- **Files.** The loader never writes to the app directory. Mods write to the app home only through
  their own host module; a mod host writes only `omo.jsonc` role rows and
  `runtime/app-mods/**`, with a backup, a journal and an optimistic-hash check before each write.
- **Single instance.** A lock file holds the helper's pid and start time. A stale lock is taken
  over; a live one makes a second helper exit 0 without launching.

## 5. Installed layout

```
<mods-home>/
  _loader/       loader code, update.mjs, config.json, app-facts.json, install-manifest.json, backups/
  modmgr/        mod.json (locked), page.js, page.css, host.mjs, host/
  sample/        mod.json, page.js, page.css, host.mjs
  ko/            mod.json, page.js
```

`tools/install.mjs` writes this layout under `~/.omo/app-mods` and a launcher `~/Applications/OmO Mods.app`
(skip it with `--no-launcher`). The launcher runs `node _loader/boot.mjs /Applications/OmO.app` and passes its
arguments on, so `--safe` works. The app bundle and its icon are never touched. `--uninstall` removes only the
files in the manifest and our launcher. Loader state and logs live in `~/Library/Application Support/omo-app-mods`.

## 6. After an app update

No build has to be recorded. The anchors decide, so a mod keeps working while its anchors exist.

1. Update OmO as usual. The loader never writes into `/Applications/OmO.app`, and `OmO Mods.app` keeps working.
2. Run `node loader/check.mjs status --json` to see which mods attached and why.
3. A mod switched off with `ANCHOR_MISSING` needs new anchors (or a new mod version). Fix `anchors` in its
   repository and bring it in with [UPDATE.md](../UPDATE.md).
4. `node loader/check.mjs --record-build` still exists if you want to note a QA'd build in `testedBuilds`. It is
   optional and changes nothing about attaching.
