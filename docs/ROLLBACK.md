# 롤백 안내

OmO를 트레이에서 완전히 종료한 뒤 저장소 폴더에서 다음 명령으로 제거할
내용을 미리 확인하세요.

```sh
node tools/install.mjs --uninstall --dry-run
node tools/install.mjs --uninstall
```

설치 도구는 아이콘 백업을 먼저 복원하고 설치 매니페스트에 기록된 파일만
제거합니다. 아이콘 백업이 없어 복원을 거부하는 경우 자세한 안내는
[롤백 문서](../ROLLBACK.md)를 참고하세요.
