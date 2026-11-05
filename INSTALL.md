# Install (macOS)

Korean version: [INSTALL.ko.md](INSTALL.ko.md)

## Requirements

- OmO at `/Applications/OmO.app` (otherwise pass `--app <bundle>`).
- Node.js 24 or newer.
- git, used by the update check.

## Steps

```sh
git clone https://github.com/dip-con/omo-desktop-mod
git clone https://github.com/dip-con/omo-desktop-ko-translation
cd omo-desktop-mod
node tools/install.mjs --mod ../omo-desktop-ko-translation/mods/ko
```

Keep both folders side by side and do not move them: updates copy from them.

Options: `--dry-run` writes nothing, `--mods-home <dir>` (default `~/.omo/app-mods`), `--apps-dir <dir>` (default `~/Applications`), `--no-launcher`. On reinstall, repeat `--mod` for every external mod you want to keep. `node tools/install.mjs --help` lists everything.

## Launch

Quit OmO first. The debug port only opens when the app starts, so the loader can't attach to a running OmO. Then open `~/Applications/OmO Mods.app` or find "OmO Mods" in Spotlight.

Safe mode: hold Shift while opening it, or run `open ~/Applications/"OmO Mods.app" --args --safe`. Opening `/Applications/OmO.app` directly also starts without mods.
