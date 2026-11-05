# 설치 안내

## 한 줄 설치

```bash
curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash
```

`install.sh`가 하는 일은 이래요.

1. Node.js 24 이상인지 확인해요.
2. 이 저장소 `main`을 임시 폴더에 받아요.
3. `node bin/install.mjs --loader github:dip-con/omo-desktop-mod#main --mod github:dip-con/omo-desktop-ko-translation/mods/ko`를 실행해요. 뒤에 붙인 옵션도 같이 넘겨요.

## bin/install.mjs 옵션

| 옵션 | 뜻 |
| --- | --- |
| `--mod <spec>` | 설치할 모드. 여러 번 쓸 수 있어요. |
| `--loader <spec>` | 로더 저장소 위치. 기본값은 지금 실행 중인 체크아웃이에요. |
| `--mods-home <dir>` | 설치 폴더. 기본값 `~/.omo/app-mods` |
| `--apps-dir <dir>` | `OmO Mods.app`을 만들 폴더. 기본값 `~/Applications` |
| `--app <bundle>` | OmO 앱 경로. 기본값 `/Applications/OmO.app` |
| `--dry-run` | 무엇을 쓰고 지울지만 보여 주고 끝나요. |
| `--uninstall` | 설치한 파일과 런처를 지워요. |

`spec`은 둘 중 하나예요.

- `github:<owner>/<repo>/<path>[#ref]` 예: `github:dip-con/omo-desktop-ko-translation/mods/ko#main`
- 로컬 폴더 경로 예: `../omo-desktop-ko-translation/mods/ko`

## 설치되는 것

```
~/.omo/app-mods/
  _loader/        로더 코드 (src/ 복사본), config.json = {app, node}
  modmgr/         모드 관리 화면 (항상 켜져 있어요)
  ko/             한글 화면 모드
  install.json    출처, 커밋, 파일 목록
~/Applications/OmO Mods.app
~/Library/Application Support/omo-app-mods/   state.json, logs/
```

다시 설치해도 각 모드의 켜짐/꺼짐은 유지돼요. 빠진 모드의 파일은 지우고, 설치 기록에 없는 파일은 건드리지 않아요.

환경 변수 `OMO_MODS_HOME`으로 설치 폴더를, `LOADER_STATE_DIR`로 상태 폴더를 바꿀 수 있어요.

## 업데이트

`node bin/update.mjs [--check] [--mod <id>]... [--mods-home <dir>]`

결과는 JSON으로 나와요. 오류가 하나라도 있으면 exit 1이에요. GitHub 출처는 커밋으로, 로컬 출처는 폴더 해시로 비교해요. 앱 안에서는 **설정 > 모드**에서 같은 일을 해요.

## 런처 직접 실행

`OmO Mods.app`은 `node ~/.omo/app-mods/_loader/loader/launch.mjs`를 부르는 작은 앱이에요. 직접 부를 때 쓸 수 있는 옵션이에요.

- `--safe`: 모드 없이 시작 (Shift를 누른 것과 같아요)
- `--no-mods`: 모드를 붙이지 않아요
- `--plan-only`: 어떻게 할지 JSON으로만 출력하고 아무것도 띄우지 않아요

## English

`install.sh` checks Node 24+, downloads this repo and runs `bin/install.mjs` with the Korean mod. Options: `--mod`, `--loader`,
`--mods-home`, `--apps-dir`, `--app`, `--dry-run`, `--uninstall`. Updates: `bin/update.mjs [--check] [--mod <id>]`.
