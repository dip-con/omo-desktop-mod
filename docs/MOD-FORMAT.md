# 모드 형식

모드는 `~/.omo/app-mods/<id>/` 폴더 하나예요. 폴더 이름이 곧 `id`예요. `_`나 `.`로 시작하는 폴더는 모드로 보지 않아요.

## mod.json

```json
{ "id": "ko", "name": "Korean UI", "nameKo": "한글 화면", "description": "앱 화면 글자를 한글로 바꿔요",
  "version": "0.3.0", "enabled": true, "locked": false, "order": 20,
  "entry": { "page": "page.js", "css": "page.css", "host": "host.mjs" },
  "settingsPage": { "id": "mods", "label": "모드" },
  "anchors": [ { "selector": "#root", "route": "*" } ],
  "source": { "repo": "dip-con/omo-desktop-ko-translation", "path": "mods/ko", "ref": "main" } }
```

| 필드 | 뜻 |
| --- | --- |
| `id`, `name`, `version` | 필수. `id`는 폴더 이름과 같아야 해요. |
| `nameKo`, `description` | 선택. `nameKo`가 없으면 `name`을 보여 줘요. |
| `enabled` | 꺼 두면 붙이지 않아요. 설정 > 모드의 스위치가 이 값을 바꿔요. |
| `locked` | `true`면 끌 수 없어요 (`modmgr`). |
| `order` | 붙이는 순서. 작은 값이 먼저예요. |
| `entry.page` | 페이지 안 격리 world에서 도는 스크립트 |
| `entry.css`, `entry.host` | 선택. 스타일, 그리고 Node 쪽 모듈 |
| `settingsPage` | 선택. 설정 화면에 붙일 페이지 |
| `anchors` | 이 선택자가 있고 경로가 맞을 때만 모드 루트를 보여 줘요. `route`는 `*` 또는 경로예요. |
| `source` | 업데이트 기본 출처. `path`, `ref`는 선택이에요. |

모르는 필드가 있으면 그 모드는 거절돼요(`BAD_FORMAT`).

## 페이지 스크립트

`page.js`는 `omoMods` 객체를 받아요.

- `omoMods.call(method, args)`: host 모듈을 불러요. Promise를 돌려주고, 30초가 지나면 실패해요.
- `omoMods.onTrusted(el, fn)`: 사용자가 실제로 일으킨 이벤트에만 반응해요.
- `omoMods.expose(obj)`: 다른 곳에서 볼 수 있게 `window.omoMods.exposed[id]`에 올려요.
- `omoMods.reload()`: 모드를 다시 읽고 화면을 새로 고쳐요.

모드가 그리는 요소에는 `data-omo-mod-root="<id>"`를 달아요. 경로가 바뀔 때 로더가 anchors를 다시 보고 이 요소를 보이거나 숨겨요.

## host 모듈

```js
export async function handle(method, args, ctx) { /* ... */ }
```

`ctx`는 `{modId, modDir, stateDir, modsHome}`이에요. 기록할 파일은 `ctx.stateDir`에 쓰세요. [지금 새로 고침]을 누르면 host 모듈도 새로 import돼요.

## 거절 이유

`state.json`의 `mods[].reason`에 남아요: `BAD_FORMAT`, `BAD_FILES`, `DISABLED`, `ANCHOR_MISSING`, `MOD_ERROR`, `HOST_FAILED`, `WATCHDOG`.

## modmgr host 메서드

| 메서드 | 돌려주는 값 |
| --- | --- |
| `list()` | `{ok, mods:[{id,name,nameKo,description,version,enabled,locked,status,reasonKo,expected}]}` |
| `setEnabled({id,on,expected})` | `{ok,id,enabled,changed,expected}`. 거절: `BAD_ARGS`, `UNKNOWN_MOD`, `STALE`, `LOCKED`, `BAD_FORMAT` |
| `checkUpdates()` | `{ok, items}`. 설치 기록이 없으면 `NO_INSTALL_RECORD` |
| `applyUpdates({ids})` | `{ok, applied, skipped, errors}` |

`expected`는 `mod.json`의 sha256이에요. 그 사이 파일이 바뀌었으면 `STALE`로 거절해요.

## English

A mod is a folder with `mod.json` (fields above; unknown fields are refused), a `page.js` run in an isolated world with
`omoMods.call/onTrusted/expose/reload`, and optional `page.css` and `host.mjs` exporting `handle(method, args, ctx)`.
