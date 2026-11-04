# 설치 안내

1. Windows에 Node.js 24 이상을 설치합니다.
2. 이 저장소를 내려받아 압축을 풀고 해당 폴더에서 터미널을 엽니다.
3. `node tools/install.mjs --with-icons --dry-run`으로 설치 내용을 확인합니다.
4. `node tools/install.mjs --with-icons`를 실행합니다. 로더와 내장 모드
   관리자가 설치되며 외부 모드는 필수가 아닙니다. 아이콘을 바꾸지 않으려면
   `--with-icons`를 빼세요.
5. 트레이에서 OmO를 완전히 종료한 뒤 평소 아이콘으로 실행합니다.

`mod.json`이 들어 있는 외부 모드는 다음처럼 추가합니다.

```sh
node tools/install.mjs --with-icons --mod "모드 폴더 경로"
```

여러 모드는 `--mod`를 반복합니다. 재설치할 때 유지할 외부 모드를 모두
지정하세요. 이전에 관리한 모드 중 생략된 파일은 제거됩니다. 설치 도구는
관리하지 않는 모드 폴더나 파일을 덮어쓰지 않습니다.
앱 실행 중 `node loader/check.mjs status`로 상태를 확인할 수 있습니다.

Shift를 누른 채 실행하거나 실행기에 `--safe`를 전달하면 한 번 모드 없이
실행합니다. 제거 방법은 [UNINSTALL.md](UNINSTALL.md)를 보세요. 로더가
실행 중일 때 앱의 로컬 디버그 포트에 같은 PC의 다른 프로그램도 접근할 수 있습니다.
