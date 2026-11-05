# 되돌리기

macOS판은 OmO 앱 아이콘이나 앱 번들을 바꾸지 않아요. 그래서 되돌릴 일은 "모드 없이 쓰기"와 "이전 버전 모드로 돌아가기" 두 가지예요.

## 모드 없이 쓰기

- `/Applications/OmO.app`을 직접 열면 모드 없이 시작해요.
- `OmO Mods.app`을 쓰면서 잠깐만 끄려면 Shift를 누른 채 열거나 `--safe`로 실행해요.
- 모드 하나만 끄려면 설정 > 모드의 스위치를 써요.
- 완전히 지우려면 [UNINSTALL.md](UNINSTALL.md).

## 이전 버전으로 돌아가기

업데이트는 원본 저장소의 파일을 복사해 와요. 원본 저장소에서 원하는 커밋으로 돌아간 뒤 다시 반영하면 돼요.

```sh
cd <원본 저장소>
git checkout <커밋>
node ~/.omo/app-mods/_loader/update.mjs --check
node ~/.omo/app-mods/_loader/update.mjs
```

`--pull` 없이 실행하면 저장소를 당겨오지 않고 지금 체크아웃된 파일을 그대로 복사해요. 로더 저장소에서 `node tools/install.mjs`를 다시 실행해도 같아요. 모드 스위치(`enabled`)를 바꾸기 전 `mod.json` 백업은 `~/.omo/app-mods/_loader/backups/<시각>/`에 있어요.

## English

The macOS edition never changes OmO's bundle or icons. To run without mods, open `/Applications/OmO.app` directly, hold Shift, or pass `--safe`. To go back to an older mod version, check out that commit in the source repository and run `node ~/.omo/app-mods/_loader/update.mjs` without `--pull` (or reinstall). Remove everything with [UNINSTALL.md](UNINSTALL.md).
