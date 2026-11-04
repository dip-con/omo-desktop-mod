# Mod format

This document describes how a mod is laid out, how the loader treats it, and what a mod may
touch. It is written for the mod author and for the maintainer who decides whether a new app
build is safe to mark as tested.

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
  "testedBuilds": ["<build key>"],
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
| `testedBuilds` | string[] | build keys the mod was QA'd on (see section 6) |
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
| `engines.vscode` | `testedBuilds` | an explicit list of app builds, not a version range |
| `enabledApiProposals` | none | no proposals; the bridge is the only extra API |

If you want to propose an "extension mode" to a developer, the mapping above is the starting
point. The difference that matters: the app's build is not a semver range. A new build is
"unknown" until someone runs the QA and records it.

## 2. Lifecycle

1. **Discover.** `loader/mods.mjs` reads `<modsRoot>/*/mod.json` (skipping `_loader`) and sorts by
   `order`, then `id`. Broken entries go to the notice with a reason.
2. **Version check.** The loader fingerprints the installed app (`loader/fingerprint.mjs`) to a
   build key. For each mod and each anchor that applies to the current route, the loader checks
   that the anchor element is present (waiting up to 5 seconds per route change).
   - An anchor missing: that mod alone is switched off, reason `ANCHOR_MISSING`.
   - All anchors present, build key not in `testedBuilds`: the mod is attached anyway, reason
     `UNKNOWN_BUILD`.
   - Otherwise: attached, no reason.
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
| `shortcuts()` | read only, asynchronous: `{ok, shortcuts}` with one row each for the three `OmO.lnk` (`label` `desktop`, `startmenu`, `taskbar`) in the account's own profile folder. A row has `path`, `kind` (`mod`: starts `launch.vbs` through `wscript.exe`; `plain`: starts `OmO.exe` with no arguments; `other`; `missing`), `error` and the link's `target`, `args`, `workdir`, `icon`, `aumid`, `description`. A missing or unreadable icon is that row's state (`missing`, or `other` with `error`); the call still answers `ok`. The answer is kept until one of the four files changes. There is no method that writes a shortcut |

Mod DOM rules: every element the mod creates lives under `[data-omo-mod-root="<id>"]`, and its
style carries `data-omo-mod="<id>"`. The loader hides these when the anchors are missing. Mods do
not move, replace or clone the app's nodes.

## 4. Security model

- **Debug port.** The app opens a Chromium remote-debugging endpoint only when it is launched
  through the mods shortcut. The loader passes `--remote-debugging-address=127.0.0.1` and an
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
  _loader/       loader code, config.json, app-facts.json, install-manifest.json, launch.vbs
  modmgr/        mod.json (locked), page.js, page.css, host.mjs, host/
  sample/        mod.json, page.js, page.css, host.mjs
  ko/            mod.json, page.js
```

`tools/install.mjs` writes this layout and makes no shortcut unless `--with-icons` is given; that
flag also runs `tools/shortcuts.mjs apply`, which points the three `OmO.lnk` icons at `launch.vbs`
through `wscript.exe` after a backup under `<mods-home>/backup/<time>`. An `OmO (모드).lnk` an older install
recorded is removed on reinstall. `--uninstall` first restores the icons from the newest backup record,
then removes only the files in the manifest; it refuses with `ICONS_STILL_RETARGETED` (nothing removed)
while an `OmO.lnk` still starts the launcher and no backup record exists.

## 6. New app version procedure

The loader trusts a build only after it has been tested on that build.

1. Update the app as usual. The loader does not change the app directory. The app's own updater
   keeps the existing icons when it runs with `KeepShortcuts=true`, so they still start the mod
   launcher. A fresh install of the app recreates `OmO.lnk` pointing at `OmO.exe`; run
   `tools/shortcuts.mjs apply` again with a new backup folder, or see ROLLBACK.md.
   Check with `node tools/shortcuts.mjs status` (no flags needed).
2. Run `node loader/check.mjs` and note the new build key and app version.
3. Run the QA on the new build: install into a temporary mods home, launch through `launch.vbs`,
   and check that each mod attaches with no reason, the settings page and the Korean text are
   correct, and that closing the app leaves no helper process.
4. Only when that passes, run `node loader/check.mjs --record-build`. It adds the build key to the
   `testedBuilds` of each mod. Review the diff and commit it. Never run `--record-build`
   automatically.
5. If the QA fails, leave `testedBuilds` alone. Mods then attach with reason `UNKNOWN_BUILD`.
   A failing anchor switches the mod off with reason `ANCHOR_MISSING`.
