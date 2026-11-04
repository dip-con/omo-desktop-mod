# OmO Desktop Loader

An unofficial Windows loader for OmO desktop mods. It attaches optional,
pluggable mods at runtime without modifying the installed app. The bundled
mod manager provides a settings page; no third-party mods are required.

## Install

Install Node.js 24 or newer, download this repository, and run in its folder:

```sh
node tools/install.mjs --with-icons
```

This installs the loader and bundled mod manager without external mods. To add
one or more external mod folders containing `mod.json`, run:

```sh
node tools/install.mjs --with-icons --mod "path/to/mod"
```

Repeat `--mod` for each external mod. On reinstall, provide every external mod
you want to keep: files from the previous manifest omitted from the new plan
are removed. Add `--dry-run` to preview. Quit OmO from the tray before
starting it with the normal icon. See [INSTALL.md](INSTALL.md) and
[INSTALL.ko.md](INSTALL.ko.md).

The Korean translation mod lives in its own repository: https://github.com/grim-susemi/omo-desktop-ko-translation

## Safe mode and uninstall

Hold Shift while launching or pass `--safe` to the launcher to start without
mods. To restore the icons and remove installer-managed files:

```sh
node tools/install.mjs --uninstall
```

See [UNINSTALL.md](UNINSTALL.md), [ROLLBACK.md](ROLLBACK.md), and
[docs/MOD-FORMAT.md](docs/MOD-FORMAT.md). The application opens a local debug
port while the loader is active; other local programs can connect to it.

## 한국어 요약

OmO 데스크톱용 비공식 모드 로더입니다. 외부 모드는 선택 사항이며
`--mod "모드 폴더"`로 추가합니다. 한국어 번역 모드는 별도 저장소(https://github.com/grim-susemi/omo-desktop-ko-translation)에 있습니다.
Shift 또는 `--safe`로 모드 없이 실행하고 `--uninstall`로 제거할 수 있습니다.
