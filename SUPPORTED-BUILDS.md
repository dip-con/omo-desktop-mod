# 버전 호환

지원 빌드 목록은 따로 두지 않아요. 모드가 붙을지는 앵커가 정해요. 실행할 때마다 로더가 각 모드의 `anchors`(화면의 특정 요소)를 찾아보고, 있으면 붙이고 없으면 그 모드만 끄고 `ANCHOR_MISSING`으로 알려요. 그래서 OmO가 업데이트돼도 화면 구조가 그대로면 모드는 계속 동작해요.

`mod.json`의 `testedBuilds`는 이제 선택 항목이고, 비어 있거나 없어도 모드는 똑같이 붙어요. 업데이트 뒤 모드가 꺼졌다면 `node loader/check.mjs status --json`으로 이유를 확인하고, 모드 저장소의 새 버전을 [UPDATE.md](UPDATE.md) 방법으로 받아 보세요.

## English

There's no supported-build list. Anchors decide: a mod attaches when its anchor elements exist on screen and is switched off with `ANCHOR_MISSING` when they don't. `testedBuilds` is optional and doesn't affect attaching.
