#!/usr/bin/env node
// node bin/status.mjs [--json] [--app <bundle>]: the loader's state.json summary and the installed OmO's appInfo.
import path from 'node:path';
import { appInfo } from '../src/core/app.mjs';
import { readJson } from '../src/core/fsx.mjs';
import { APP_BUNDLE, stateDir } from '../src/core/paths.mjs';
import { isAlive } from '../src/core/proc.mjs';

export function summarize(state, app) {
  return {
    running: Number.isInteger(state?.omoPid) && isAlive(state.omoPid),
    omoPid: state?.omoPid ?? null,
    port: state?.port ?? null,
    startedAt: state?.startedAt ?? null,
    mods: state?.mods ?? [],
    app,
  };
}

export function render(s) {
  const lines = [
    `OmO: ${s.app.version ?? '알 수 없음'} (client ${s.app.client?.slice(0, 12) ?? '-'}, runtime ${s.app.runtime.ref ?? '-'})`,
    s.omoPid === null ? '모드 도우미로 연 기록이 없어요.' : `OmO pid ${s.omoPid} (${s.running ? '실행 중' : '종료됨'}), 포트 ${s.port}, 시작 ${s.startedAt}`,
  ];
  for (const m of s.mods) lines.push(`- ${m.id}: ${m.attached ? '켜짐' : `꺼짐 (${m.reason})`}`);
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const appIndex = argv.indexOf('--app');
const bundle = appIndex >= 0 ? argv[appIndex + 1] : APP_BUNDLE;
const summary = summarize(readJson(path.join(stateDir(), 'state.json'), null), appInfo(bundle));
console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : render(summary));
