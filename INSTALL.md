# Install

1. Install Node.js 24 or newer on Windows.
2. Download and unpack this repository, then open a terminal in its folder.
3. Run `node tools/install.mjs --with-icons --dry-run` to preview.
4. Run `node tools/install.mjs --with-icons` to install the loader and bundled
   mod manager without external mods. Omit `--with-icons` to leave icons alone.
5. Quit OmO completely from the tray and launch it using your usual icon.

To install an external mod, pass its folder containing `mod.json`:

```sh
node tools/install.mjs --with-icons --mod "path/to/mod"
```

Repeat `--mod` for additional mods. On reinstall, supply every external mod
you want to retain; omitted previously managed mod files are removed. The
installer refuses to overwrite foreign files or an unmanaged mod folder.
Use `node loader/check.mjs status` while the app is open to inspect mod status.

Hold Shift while launching, or pass `--safe` to the launcher, for a single
launch without mods. For removal see [UNINSTALL.md](UNINSTALL.md).
The app exposes a local debug port while the loader is active; other local
programs can connect to it.
