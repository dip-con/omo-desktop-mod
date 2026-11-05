# OmO Mods

OmO 데스크톱 앱에 모드를 붙여 주는 macOS용 로더예요. 앱 파일은 건드리지 않아요. 대신 OmO를 디버그 포트와 함께 띄우고, 화면이 열릴 때 모드 스크립트를 넣어요. 기본으로 한글 화면 모드(`ko`)와 모드 관리 화면(`modmgr`)이 같이 설치돼요.

필요한 것: macOS, `/Applications/OmO.app`, Node.js 24 이상.

## 설치 (한 줄)

```bash
curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash
```

옵션은 `bin/install.mjs`로 그대로 넘어가요. 미리 보기만 하려면 이렇게 하세요.

```bash
curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash -s -- --dry-run
```

## 클론에서 직접 설치

두 저장소를 나란히 받은 뒤 로더 폴더에서 실행해요.

```bash
git clone https://github.com/dip-con/omo-desktop-mod.git
git clone https://github.com/dip-con/omo-desktop-ko-translation.git
cd omo-desktop-mod
node bin/install.mjs --mod ../omo-desktop-ko-translation/mods/ko
```

자세한 옵션은 [docs/INSTALL.md](docs/INSTALL.md)에 있어요.

## 사용하기

1. OmO를 완전히 종료해요.
2. `~/Applications/OmO Mods.app`(Spotlight에서 "OmO Mods")을 열어요.
3. OmO가 모드와 함께 열려요.

OmO가 이미 떠 있으면 OmO Mods는 그 앱을 끄지 않아요. "OmO가 이미 실행 중이에요." 안내가 뜨면 OmO를 종료하고 다시 여세요.

**안전 모드:** OmO Mods를 열 때 Shift를 누르고 있으면 모드 없이 열려요. 모드 때문에 화면이 깨졌을 때 쓰면 돼요.

상태 확인: `node bin/status.mjs` (`--json`으로 JSON 출력).

## 업데이트

앱의 **설정 > 모드**에서 [업데이트 확인], [업데이트 적용], [지금 새로 고침] 순서로 눌러요. 같은 화면에서 모드를 켜고 끌 수도 있어요.

터미널에서는 이렇게 해요.

```bash
node bin/update.mjs --check   # 확인만
node bin/update.mjs           # 모두 적용
node bin/update.mjs --mod ko  # 한 모드만
```

## 제거

```bash
node bin/install.mjs --uninstall
```

설치 기록(`~/.omo/app-mods/install.json`)에 있는 파일과 `OmO Mods.app`만 지워요. OmO.app은 그대로예요.

## 보안 안내

OmO Mods로 연 OmO는 `127.0.0.1`의 디버그 포트(CDP)를 열어 둬요. 이 포트는 같은 Mac 안에서만 접근돼요. 그래도 그 Mac에서 도는 다른 프로그램은 이 포트로 OmO 화면을 조작할 수 있어요. 믿을 수 없는 프로그램이 도는 컴퓨터라면 쓰지 마세요. OmO를 종료하면 포트도 닫혀요. 일반 방법으로 연 OmO는 포트를 열지 않아요.

## 문서

- [docs/INSTALL.md](docs/INSTALL.md): 설치 옵션, 설치 위치
- [docs/MOD-FORMAT.md](docs/MOD-FORMAT.md): 모드 만들기, `mod.json` 형식
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): 동작 방식, 모듈 지도

개발: `npm test`

## English

OmO Mods is a macOS loader that injects mods into the OmO desktop app without modifying the app. Install with
`curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash` (Node.js 24+), then open
`~/Applications/OmO Mods.app` while OmO is closed. Hold Shift to start without mods. Update from Settings > 모드 or with
`node bin/update.mjs`, uninstall with `node bin/install.mjs --uninstall`. The modded app exposes a debug port on
127.0.0.1 only, so any local program can control it while it runs. License: MIT.
