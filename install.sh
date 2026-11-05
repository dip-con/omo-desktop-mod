#!/bin/bash
# OmO Mods 설치: curl -fsSL https://raw.githubusercontent.com/dip-con/omo-desktop-mod/main/install.sh | bash
# 추가 옵션은 bin/install.mjs로 그대로 넘겨요 (예: bash -s -- --dry-run).
set -euo pipefail

REPO="dip-con/omo-desktop-mod"
REF="main"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 이상이 필요해요. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "Node.js 24 이상이 필요해요 (지금: $(node --version))." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" -o "$tmp/loader.tar.gz"
tar -xzf "$tmp/loader.tar.gz" -C "$tmp"
src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

node "$src/bin/install.mjs" --loader "github:${REPO}#${REF}" \
  --mod github:dip-con/omo-desktop-ko-translation/mods/ko "$@"
