# Loader

The loader starts (or attaches to) the OmO desktop app with a loopback debugging port, injects the enabled mods
into the main window on every document load and every in-page route change, and exits when the app's browser
connection closes. Mods live beside this folder (see "Mod folder").

## Entry and commands

- `node loader/boot.mjs <appBundle> [--safe]`: what `~/Applications/OmO Mods.app` runs (with `/Applications/OmO.app`).
  If the loader cannot start it shows a dialog and starts the app plainly (`<bundle>/Contents/MacOS/OmO`).
- `node loader/launch.mjs [--no-mods] [--safe] [--plan-only]`: the launch logic. `--no-mods` / `--safe` (or Shift held)
  start the app without injection. `--plan-only` decides and prints one JSON line `{action, exitCode, port, omoProfile}` without
  spawning, showing a box, or writing state (the lock and logs still go to the state directory).
- `node loader/main.mjs`: thin alias of the same entry.
- `node loader/check.mjs`: `{fingerprint, appVersion, mods:[{id, enabled, tested}]}`.
- `node loader/check.mjs status --json`: `{running, modded, port, fingerprint, mods:[{id, attached, reason}]}`.
- `node loader/check.mjs --record-build`: adds the current build key to each `mod.json` `testedBuilds`. Optional and
  informational; attaching is decided by anchors only.
- `node loader/update.mjs [--check] [--pull] [--mod <id>]... [--mods-home <dir>]`: update check / apply, see the top `UPDATE.md`.

## Mod folder and mod.json

A mod is `<modsRoot>/<id>/mod.json`. `modsRoot` is the parent of the `_loader` folder when installed (`MODS_HOME`);
from the repository it is `REPO/mods`. The folder name must equal `id`.

```
{ "id": "sample", "name": "Sample", "nameKo": "프로필", "version": "0.1.0", "enabled": true, "order": 10,
  "entry": { "page": "page.js", "css": "style.css", "host": "host.mjs" },
  "contributes": { "settingsPage": { "id": "sample", "label": "프로필" } },
  "update": { "repo": "/Users/me/src/sample-mod", "subdir": "mods/sample" },
  "anchors": [ { "selector": "[data-settings-nav-path=\"/settings/general\"]", "route": "/settings/general" } ] }
```

- `route` is `*`, a path prefix with a trailing slash (`/settings/`), or an exact path (`/settings/general`).
- `entry.page`, `entry.css`, `entry.host` are relative paths inside the mod folder.
- `testedBuilds` (optional string array) is informational. `update` (optional `{repo, subdir?}`) names the source used
  by the update check when the install manifest has none.
- `descriptionKo` (optional string) is the Korean line shown in Settings > 모드. `locked` (optional boolean) keeps a mod
  injected whatever `enabled` says; only the built-in `modmgr` sets it.
- A mod that fails the format check is skipped and shown in the notice with reason `BAD_FORMAT`.
- A mod with `enabled: false` is never injected and is reported with reason `DISABLED`. To turn Korean off, set `"enabled": false` in the installed `ko/mod.json` (a reinstall keeps that setting); `--no-mods` starts the app with no mods.

## Page API (in the mod's page script)

The page script runs in an isolated world. It is called as `function (omoMods) { ... }`:

- `omoMods.call(method, args)` → Promise. Calls the mod's host module. Rejects with `BRIDGE_TIMEOUT` after the
  bridge timeout (30 s); the page then shows the banner `data-omo-state="bridge-lost"`.
- `omoMods.onTrusted(element, fn)`: runs `fn` only for a real user click (`event.isTrusted`). Scripted `.click()` is ignored.
- `omoMods.omoProfile`: the `OMO_PROFILE` value read by the loader, or `null`. Read only.
- Put every element the mod owns under `[data-omo-mod-root="<id>"]`. When the mod's anchors are missing on a route, the
  loader hides that root and sets the mod's style disabled. The mod's run is not repeated.

## Host module

`entry.host` names an ES module that exports `handle(method, args)`. Its return value (or resolved value) is sent to the
page as `{ok: true, value}`. A throw or rejection is sent as `{ok: false, error}`. The method name must match
`[A-Za-z][A-Za-z0-9_.]{0,63}`, and `args` must be an array of at most 64 KB as JSON.

## Reserved control messages (page to loader, not for mods)

`__plan` (args `[states, pathname]`), `__fail` (a mod threw while running), `__watchdog` (an empty `#root` or an
uncaught error after load), `__reload` (Settings > 모드 [지금 새로 고침]: read the mods again, replace the registered
bundle in each attached window, reload it). Other `__` names are refused.

## Reason codes

| Code | Meaning |
|---|---|
| `ANCHOR_MISSING` | an anchor for the current route is absent after the 5 s wait; that mod is hidden |
| `DISABLED` | `enabled: false` |
| `BAD_FORMAT` | `mod.json` fails the format check |
| `BAD_FILES` | a page, css or host file cannot be read, or the page does not compile |
| `MOD_ERROR` | the mod threw while running |
| `WATCHDOG` | the loader detached all mods and reloaded the page without them |
| `OMO_PROFILE_SET` | `OMO_PROFILE` is set; shown in the notice |

`BINDING_LOST` is written to the log only.

## Launch environment and state

- The app gets the parent environment unchanged, plus `OMO_DESKTOP_REMOTE_DEBUGGING_PORT=<port>`, and the argument
  `--remote-debugging-address=127.0.0.1`. Nothing is scrubbed. `OMO_PROFILE` is read from the spawn environment, else
  from `launchctl getenv OMO_PROFILE` (read only). It is never written or cleared.
- The home guard runs first: the real home must equal `os.homedir()`, and no agent-dir variable may point elsewhere
  (otherwise exit 4, no spawn).
- State file: `~/Library/Application Support/omo-app-mods/state.json` (override for tests: `LOADER_STATE_DIR`). Fields: `omoPid`,
  `port`, `fingerprint`, `startedAt`, `omoProfile`, `pathname`, `mods: [{id, attached, reason}]`. Written atomically.
- Lock: `loader.lock` in the state directory, JSON `{pid, startedAt}`. A second helper stops if the lock is not stale (see the lifecycle contract).
- Logs: `logs/launch-<UTC>.log` in the state directory, the newest ten kept.

## Lifecycle contract

- What ends the helper: the browser socket closed and OmO gone (exit 0), or the socket closed, OmO alive, and
  `/json/version` failing for 10 s (exit 5). The 10 s rule is `exitDecision` in `ownership.mjs`, applied by `watchApp`
  in `lifecycle.mjs`. Launch failures keep their codes (2, 3, 4, 6).
- What reattaches: the socket closed while OmO is alive and `/json/version` answers. The helper reconnects once per loss,
  with no polling loop after a successful re-attach. A socket that closes again within one poll interval (1 s) waits for
  that interval before the next re-attach, so a socket that closes as soon as it opens cannot loop tightly. A failed re-attach is retried on a 1 s schedule. A target that dies
  while the socket stays open (`Target.targetDestroyed`, `Inspector.detached`) is dropped, and the next
  `Target.targetCreated` is attached as usual. A renderer crash (`Inspector.targetCrashed`) keeps the session: the entry
  is only marked crashed, so the watchdog still acts on it.
- Owner PID: the port's owner (`lsof`) must be the spawned OmO pid recorded in the state (or the recorded
  pid in attach mode), or one of its descendants (child lookup over `ps`).
- Stale lock: the lock is stale when its pid is dead, or when the pid now belongs to a process that started after the
  lock's `startedAt` (pid reuse). A legacy plain-pid lock is judged by liveness only. An unknown start time counts as not
  stale.
- Port TOCTOU: the product must know the debug port before OmO spawns, so the loader picks a free loopback port and then
  OmO binds it. Another process can take the port in between. The risk is accepted: OmO binds 127.0.0.1 only, and a port
  taken by another process fails the owner check instead of attaching to it. Blocked ports are skipped, because Node's built-in WebSocket and fetch refuse them (`loader/ports.mjs`).
- Watchdog: when a mod throws an uncaught error or `#root` empties, the loader removes the bundle, reloads the page
  pristine, and then shows the notice. The badge comes from `notice.js`, evaluated in the isolated world after the load,
  with `data-omo-notice` and `data-reason="WATCHDOG"`, appended to `body` outside `#root`. No mod code runs in it.
  A renderer crash keeps the session (Chromium keeps the document script), so the watchdog acts on the owning session.
  At most 3 reloads per target (`MAX_WATCHDOG_RELOADS`); after that the loader stops reloading and only shows the notice.
  The script is removed at the first watchdog, so the cap does not guard against a duplicate script. It bounds the reload loop
  when a page keeps failing with no bundle attached, which the loader could not otherwise stop.
  One message box per target. One reload per episode: a second watchdog while a reload is pending is ignored until the
  reloaded document has loaded. One notice per reloaded document, evaluated after the reload's own committed navigation.
- The helper never closes or kills OmO. The only signal call is the signal-0 liveness probe in `pid.mjs` (checked by a test).

## Decisions and known gaps

- Plan branch (a) "`OmO.app/Contents/MacOS/OmO` missing" is read as "OmO not running". A missing executable exits 2.
- Running OmO with any unmet attach condition exits 3, with a message box: quit OmO and start it again
  from `OmO Mods.app` (`NOT_RUNNING_TEXT`).
- Build key = sha256 of `[appVersion, client, omoRef, omoSha, plugin]`.
- Route changes are detected by `popstate`, `hashchange`, and the DOM mutation that follows an in-page `pushState`.
  A `pushState` that changes no DOM is not seen until the next mutation.
- The owner check accepts the spawned or recorded OmO pid and its descendants, not any OmO process.
- Not verified outside the tests: the reattach and exit paths against the real app. The `Inspector.targetCrashed`
  handler has no test yet.
