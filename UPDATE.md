# 업데이트

로더와 모드는 설치한 원본 저장소(설치 기록의 `sources`, 없으면 `mod.json`의 `update`)와 비교해서 업데이트해요. 설치된 폴더와 원본 폴더의 내용 해시가 다르면 "새 버전 있음"이에요.

## 설정 화면에서

설정 > 모드 > 업데이트 카드에서 [업데이트 확인]을 눌러요. 바뀐 모드가 있으면 [업데이트 적용]이 나와요. 적용하면 원본 저장소를 `git pull`한 뒤 복사해요. 끝나면 "창을 새로 고치면 적용돼요" 안내의 [지금 새로 고침]을 눌러요.

## 터미널에서

```sh
node ~/.omo/app-mods/_loader/update.mjs --check     # 확인만
node ~/.omo/app-mods/_loader/update.mjs --pull      # git pull 후 적용
node ~/.omo/app-mods/_loader/update.mjs             # 지금 체크아웃 그대로 적용
node ~/.omo/app-mods/_loader/update.mjs --check --mod ko   # 한 모드만
```

결과는 JSON으로 나오고, 항목 하나라도 오류면 종료 코드가 1이에요. 로더 저장소에서 `node tools/update.mjs`로 같은 명령을 쓸 수도 있어요.

알아 둘 점:

- `--pull`은 저장소마다 한 번, 작업 중인 변경이 없고 upstream이 있을 때만 당겨와요. 그렇지 않으면 당기지 않고 지금 파일로 복사해요.
- 켜고 끈 설정(`enabled`)은 유지돼요. `_loader`의 설정, 설치 기록, 백업, 로그도 그대로예요.
- 적용은 임시 폴더에 먼저 복사한 뒤 바꿔 끼우고, 실패하면 이전 폴더로 되돌려요.
- 오류: `NO_MANIFEST`(설치 기록 없음, 다시 설치하세요), `NO_SOURCE`, `SOURCE_MISSING`(원본 폴더를 옮기거나 지움), `READ_FAILED`.

## English

Settings > 모드 > 업데이트: press [업데이트 확인], then [업데이트 적용] (pulls, then copies), then reload. CLI: `node ~/.omo/app-mods/_loader/update.mjs --check | --pull [--mod <id>]... [--mods-home <dir>]`, JSON output, exit 1 on any error. `enabled` and the `_loader` config/manifest/backups/logs are kept.
