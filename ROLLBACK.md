# Rollback

This page covers putting the three OmO icons back and removing the mods. Paths use Windows variables such as `%USERPROFILE%`. `<mods-home>` is the mods home the installer used; `node tools/install.mjs --help` prints its default.

## How the icons were changed

`node tools/install.mjs --with-icons` runs `tools/shortcuts.mjs apply`. It points the three usual `OmO.lnk` icons (Desktop, Start Menu, taskbar pin) at the mod launcher. Before changing anything it copies each icon into `<mods-home>\backup\<time>` and writes a `manifest.json` there with each icon's sha256.

## Restore the icons and remove the mods

The usual way is one command, described in [UNINSTALL.md](UNINSTALL.md):

```
node tools/install.mjs --uninstall
```

It restores the icons from the newest backup record first, then removes the files listed in the install manifest.

## Restore only the icons

```
node tools/shortcuts.mjs status
node tools/shortcuts.mjs restore --backup-dir <backup-folder> --dry-run
node tools/shortcuts.mjs restore --backup-dir <backup-folder>
```

`<backup-folder>` is one of the `<mods-home>\backup\<time>` folders. `status` only reads. `restore` copies the backed-up bytes back, checks each sha256, and then removes the `manifest.json`. The icon folders resolve from your Windows profile; pass `--desktop-dir`, `--start-menu-dir` or `--taskbar-dir` only if yours are somewhere else.

`restore` stops without writing on:

- `NO_MANIFEST`: the folder has no `manifest.json`. The icons were already restored, or it's the wrong folder.
- `BACKUP_MISSING` or `BACKUP_MISMATCH`: a backup file is gone or changed.

For the next `apply`, use a new, empty backup folder. The backups keep a read-only attribute, so a second `apply` into the same folder can fail with `EPERM`.

## ICONS_STILL_RETARGETED

`--uninstall` refuses with `ICONS_STILL_RETARGETED`, and removes nothing, when an `OmO.lnk` still starts the mod launcher and `<mods-home>\backup` holds no backup record. To fix it:

1. Quit OmO from the tray.
2. If you still have a backup folder somewhere else, run the `restore` command above with `--backup-dir` pointing at it.
3. Otherwise, delete the changed `OmO.lnk` icons and make new ones: right-click `OmO.exe` in the OmO install folder (usually `%LOCALAPPDATA%\Programs\omo`) and pin it, or reinstall OmO so its installer creates the icons again.
4. Run `node tools/install.mjs --uninstall` again. With no retargeted icon left, it removes the mods.

## 한국어 요약

보통은 `node tools/install.mjs --uninstall` 하나로 아이콘을 되돌리고 모드를 지워요. 아이콘만 되돌릴 때는 `node tools/shortcuts.mjs restore --backup-dir <백업 폴더>`를 써요.
`ICONS_STILL_RETARGETED`가 나오면 백업 기록이 없는 거라서, 다른 곳의 백업으로 되돌리거나 OmO 아이콘을 새로 만든 뒤 다시 `--uninstall`을 실행해요.
