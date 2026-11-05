# OmO 데스크톱 모드 로더 (macOS)

OmO 데스크톱 앱에 모드를 붙이는 비공식 로더예요. 설치된 앱(`/Applications/OmO.app`)은 건드리지 않고, 실행할 때만 모드를 붙여요. 함께 들어 있는 모드 관리 화면(설정 > 모드)에서 모드를 켜고 끄고 업데이트할 수 있어요. 외부 모드는 없어도 돼요.

## 설치

Node.js 24 이상이 필요해요. 저장소를 받은 뒤 그 폴더에서 실행해요.

```sh
node tools/install.mjs --mod <ko 저장소>/mods/ko
```

`--mod`를 빼면 로더와 모드 관리 화면만 설치돼요. 설치가 끝나면 `~/Applications/OmO Mods.app`이 생겨요. OmO를 먼저 완전히 종료하고, 이 앱(또는 Spotlight에서 "OmO Mods")으로 실행하세요. 자세한 순서는 [INSTALL.ko.md](INSTALL.ko.md)에 있어요.

## 더 보기

- 안전 모드: Shift를 누른 채 실행하거나 `--safe`를 넘기면 모드 없이 시작해요.
- 업데이트: [UPDATE.md](UPDATE.md)
- 제거: [UNINSTALL.md](UNINSTALL.md), 되돌리기: [ROLLBACK.md](ROLLBACK.md)
- 버전 호환: [SUPPORTED-BUILDS.md](SUPPORTED-BUILDS.md)
- 모드 만들기: [docs/MOD-FORMAT.md](docs/MOD-FORMAT.md)

로더가 앱을 실행하는 동안 앱은 로컬 디버그 포트(127.0.0.1)를 열어요. 같은 컴퓨터의 다른 프로그램도 거기에 접속할 수 있어요.

## 한국어 번역 모드와 라이선스

한국어 화면 모드는 [dip-con/omo-desktop-ko-translation](https://github.com/dip-con/omo-desktop-ko-translation)에 있어요. 라이선스는 MIT예요. [LICENSE](LICENSE)를 보세요.

## English

An unofficial macOS loader for OmO desktop mods (MIT). It attaches mods at launch and never modifies `/Applications/OmO.app`.

Install with Node.js 24+: `node tools/install.mjs --mod <ko repo>/mods/ko` (omit `--mod` for the loader only). Quit OmO, then start it from `~/Applications/OmO Mods.app` or Spotlight. Hold Shift or pass `--safe` to start without mods. See [INSTALL.md](INSTALL.md), [UPDATE.md](UPDATE.md), [UNINSTALL.md](UNINSTALL.md) and [docs/MOD-FORMAT.md](docs/MOD-FORMAT.md).
