# 설치 (macOS)

## 준비

- OmO 데스크톱 앱이 `/Applications/OmO.app`에 있어야 해요. 다른 곳에 있으면 `--app <경로>`로 알려 주세요.
- Node.js 24 이상. `node --version`으로 확인해요.
- git (업데이트 기능이 원본 저장소를 읽어요).

## 1. 저장소 받기

```sh
git clone https://github.com/dip-con/omo-desktop-mod
git clone https://github.com/dip-con/omo-desktop-ko-translation
cd omo-desktop-mod
```

두 폴더는 같은 곳에 나란히 두고 지우거나 옮기지 마세요. 업데이트할 때 여기서 새 파일을 가져와요.

## 2. 설치하기

```sh
node tools/install.mjs --mod ../omo-desktop-ko-translation/mods/ko
```

- 미리 보기만 하려면 `--dry-run`을 붙여요. 아무것도 쓰지 않아요.
- 설치 위치는 `~/.omo/app-mods`예요. 바꾸려면 `--mods-home <폴더>`.
- 실행용 앱 `OmO Mods.app`은 `~/Applications`에 만들어져요. 바꾸려면 `--apps-dir <폴더>`, 만들지 않으려면 `--no-launcher`.
- 다시 설치할 때는 남겨 둘 외부 모드마다 `--mod`를 다시 넣어 주세요. 빠진 모드의 파일은 지워져요. 켜고 끈 설정은 유지돼요.
- 전체 옵션: `node tools/install.mjs --help`

## 3. 실행하기

1. **OmO를 먼저 완전히 종료하세요** (메뉴 막대에서 종료, 또는 Cmd+Q). 디버그 포트는 앱이 시작될 때만 열려서, 이미 떠 있는 OmO에는 모드를 붙일 수 없어요.
2. `~/Applications/OmO Mods.app`을 열어요. Spotlight에서 "OmO Mods"로 찾아도 돼요. Dock에 고정해 두면 편해요.
3. 설정 > 모드에 로더와 모드 목록이 보이면 된 거예요.

## 안전 모드

모드 때문에 화면이 이상하면 모드 없이 시작해요.

- Shift를 누른 채 `OmO Mods.app`을 열어요.
- 또는 터미널에서: `open ~/Applications/"OmO Mods.app" --args --safe`

평소처럼 `/Applications/OmO.app`을 직접 열어도 모드 없이 시작돼요.

다음 문서: [UPDATE.md](UPDATE.md), [UNINSTALL.md](UNINSTALL.md)
