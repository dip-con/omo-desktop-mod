# Uninstall

Open a terminal in the folder you installed from and run:

```
node tools/install.mjs --uninstall
```

Add `--dry-run` first if you want to see the plan without changing anything.

## What it does, in order

1. **Icons first.** It restores the `OmO.lnk` icons from the newest backup record the installer made, checking each file's sha256.
2. **Then the mods.** It removes exactly the files listed in the install manifest, then the manifest itself. Files you added yourself stay where they are.

## When there's no backup record

If an `OmO.lnk` still starts the mod launcher and no backup record exists, uninstall refuses with `ICONS_STILL_RETARGETED` and removes nothing. That way you're never left with icons pointing at a launcher that's gone. [ROLLBACK.md](ROLLBACK.md) explains how to put the icons back by hand.

## 한국어 요약

`node tools/install.mjs --uninstall`을 실행하면 먼저 가장 최근 백업으로 아이콘을 되돌리고, 그다음 설치한 파일만 지워요.
아이콘이 아직 모드 실행기를 가리키는데 백업 기록이 없으면 `ICONS_STILL_RETARGETED`로 멈추고 아무것도 지우지 않아요. 고치는 방법은 [ROLLBACK.md](ROLLBACK.md)에 있어요.
