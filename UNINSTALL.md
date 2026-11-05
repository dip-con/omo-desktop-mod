# 제거

OmO를 종료한 뒤 로더 저장소 폴더에서 실행해요. 설치할 때 `--mods-home`이나 `--apps-dir`을 바꿨다면 같은 값을 넣어 주세요.

```sh
node tools/install.mjs --uninstall
```

설치 기록(`~/.omo/app-mods/_loader/install-manifest.json`)에 있는 파일과, 설치 도구가 만든 `OmO Mods.app`만 지워요. 직접 만든 파일은 남겨요. `/Applications/OmO.app`은 처음부터 바꾸지 않았으니 되돌릴 것도 없어요.

남는 것:

- 비어 있지 않은 폴더 (`~/.omo/app-mods` 안의 직접 만든 파일)
- 로더 상태와 로그: `~/Library/Application Support/omo-app-mods`. 필요 없으면 직접 지워도 돼요.

한 모드만 빼려면 제거 대신 그 모드의 `--mod` 없이 다시 설치하거나, 설정 > 모드에서 꺼 두세요.

## English

Quit OmO and run `node tools/install.mjs --uninstall` from the loader checkout (repeat any `--mods-home` / `--apps-dir` you used). It removes the files in the install manifest and our `OmO Mods.app` only. State and logs in `~/Library/Application Support/omo-app-mods` stay; delete them by hand if you like.
