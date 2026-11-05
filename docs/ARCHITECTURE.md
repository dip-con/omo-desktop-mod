# 구조

## 동작 방식

OmO.app은 asar와 inspect가 퓨즈로 잠겨 있어서 앱 파일을 고칠 수 없어요. 그 대신 앱이 읽는 환경 변수 `OMO_DESKTOP_REMOTE_DEBUGGING_PORT`를 써요.

1. 로더가 빈 루프백 포트를 골라요.
2. 그 포트를 환경 변수에 넣고 `<bundle>/Contents/MacOS/OmO --remote-debugging-address=127.0.0.1`을 띄워요.
3. CDP(Chrome DevTools Protocol)로 붙어서 URL이 `omo://app...`인 메인 창을 찾아요.
4. `Page.addScriptToEvaluateOnNewDocument({worldName:"omo-mods"})`로 모드 묶음을 등록해요. 모드는 앱 코드와 분리된 격리 world에서 돌아요.
5. `Runtime.addBinding`으로 `__omoModsCall` 바인딩을 격리 world에만 만들어요. 페이지의 `omoMods.call`은 이 바인딩을 거쳐 로더의 host 모듈로 가요.
6. OmO가 끝날 때까지 지켜봐요. 끊기면 다시 붙어요.

### 실행 판단

- OmO가 안 떠 있으면 새로 띄워요.
- 떠 있고, 기록된 포트가 응답하고 그 포트 주인이 OmO 프로세스 트리면 다시 붙어요.
- 그 밖에는 안내 창을 띄우고 exit 3으로 끝나요. OmO를 절대 끄지 않아요.
- 앱을 띄우기 전에 실패하면 포트 없이 평범하게 띄우고 안내해요(exit 20).
- Shift 또는 `--safe`면 모드 없이 시작해요.

### 감시견

모드에서 잡히지 않은 오류가 나거나 `#root`가 비면 묶음을 빼고 모드 없이 다시 읽어요. 창마다 최대 3번이에요.

## 모듈 지도

```
src/core/       paths (기본 경로), app (앱 버전/해시), proc (ps, lsof, Shift, 안내 창),
                cdp (WebSocket 클라이언트), fsx (JSON, 원자적 쓰기, 폴더 해시), entry
src/loader/     launch (진입점, 판단), deps (실제 의존성), lifecycle (감시 루프),
                mods (mod.json 검증, 탐색), inject (묶음 만들기, CDP 붙이기, host 호출), watchdog
src/runtime/    page.js (페이지 안 런타임, 알림 배지)
src/update/     github (커밋 조회, tarball), tree (출처 처리), update (check, apply)
src/install/    install (설치, 제거), launcher (OmO Mods.app)
mods/modmgr/    설정 > 모드 화면
bin/            install.mjs, update.mjs, status.mjs
```

설치하면 `src/`가 `~/.omo/app-mods/_loader/`로 그대로 복사돼요.

## 상태 파일

`~/Library/Application Support/omo-app-mods/state.json` = `{omoPid, port, app, startedAt, mods:[{id,attached,reason}]}`. 로그는 `logs/launch-<시각>.log`에 10개까지 남아요. 확인은 `node bin/status.mjs`로 해요.

## English

The loader starts OmO with `OMO_DESKTOP_REMOTE_DEBUGGING_PORT` on a free 127.0.0.1 port, attaches over CDP to the `omo:` / `app`
page, registers the mod bundle in the isolated world `omo-mods`, and bridges calls through the `__omoModsCall` binding.
It never kills OmO and falls back to a plain start on early failure.
