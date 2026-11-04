# Supported builds

The loader identifies a build by a key computed from the app version, the client bundle hash, the runtime ref and sha, and the plugin hash (`loader/fingerprint.mjs`). A mod lists the keys it was tested on in `testedBuilds` in its `mod.json`.

| OmO version | Build key | Mod tested |
| --- | --- | --- |
| 2026.1102.3 | `9ae0f822a89fb040d965883a6db99db062a1dc2f4c125506f51bca9f4e04faf8` | modmgr |

On other builds, a mod may report `UNKNOWN_BUILD` until its maintainer tests the build.

## 한국어 요약

시험한 빌드는 OmO 2026.1102.3이에요. 다른 빌드에서도 모드는 붙지만 `UNKNOWN_BUILD`로 나오고, 업데이트 뒤 확인 순서를 마치면 시험한 빌드로 기록돼요.
