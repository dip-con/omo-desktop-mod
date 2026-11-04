// Entry that launch.vbs runs: node loader/boot.mjs <OmO.exe> [--safe]. It has no static imports, so a broken
// launch.mjs, deps.mjs or messages.mjs still reaches failOpen, which starts OmO once without mods and says so.
// Fallback texts are literal here on purpose: this entry imports nothing, so a broken messages.mjs cannot stop it.
export const PLAIN_START_TEXT = '모드 도우미가 시작하지 못해 OmO를 모드 없이 열었어요. 다시 열면 모드를 다시 시도해요.';
export const BOX_TITLE = 'OmO (모드)';
const BOX_COMMAND = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:LOADER_MESSAGE_TEXT, $env:LOADER_MESSAGE_TITLE) | Out-Null';

// Plain start: OmO.exe with no arguments and without the debug-port variable. The message is shown by the caller's box.
export async function failOpen(appExe, io) {
  // A start already happened in this run (launch.mjs tags that rejection): the app is up, so start nothing.
  if (io.started) return 6;
  const env = { ...io.env };
  delete env.OMO_DESKTOP_REMOTE_DEBUGGING_PORT;
  const child = io.spawn(appExe, [], { env, detached: true, stdio: 'ignore' });
  child.on('error', (err) => io.onError(err));
  child.unref();
  io.messageBox();
  return 20;
}

async function runBoot(appExe, flags) {
  try {
    const { main } = await import('./launch.mjs');
    return await main(flags);
  } catch (err) {
    console.error(`boot: ${err.message}`);
    const { spawn } = await import('node:child_process');
    const box = () => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', BOX_COMMAND], {
        env: { ...process.env, LOADER_MESSAGE_TEXT: PLAIN_START_TEXT, LOADER_MESSAGE_TITLE: BOX_TITLE },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.on('error', (e) => console.error(`boot: message box failed: ${e.message}`));
      child.unref();
    };
    return failOpen(appExe, {
      started: err.started === true,
      env: process.env,
      spawn,
      messageBox: box,
      onError: (e) => console.error(`boot: plain start failed: ${e.message}`),
    });
  }
}

async function isEntry() {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (await isEntry()) {
  const [appExe = '', ...flags] = process.argv.slice(2);
  process.exitCode = await runBoot(appExe, flags);
}
