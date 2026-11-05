// Entry that the macOS launcher runs: node loader/boot.mjs <OmO.app bundle> [--safe]. It has no static imports, so a broken
// launch.mjs, deps.mjs or messages.mjs still reaches failOpen, which starts OmO once without mods and says so.
// Fallback texts are literal here on purpose: this entry imports nothing, so a broken messages.mjs cannot stop it.
export const PLAIN_START_TEXT = '모드 도우미가 시작하지 못해 OmO를 모드 없이 열었어요. 다시 열면 모드를 다시 시도해요.';
export const BOX_TITLE = 'OmO (모드)';
const DEFAULT_APP_BUNDLE = '/Applications/OmO.app';
// The dialog text and title travel as argv, so nothing is quoted into the AppleScript.
const BOX_ARGS = ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"확인"} default button 1', '-e', 'end run', PLAIN_START_TEXT, BOX_TITLE];

// The executable inside an app bundle (string join: this entry imports nothing).
export function bundleExe(appBundle) {
  return `${(appBundle || DEFAULT_APP_BUNDLE).replace(/\/+$/, '')}/Contents/MacOS/OmO`;
}

// Plain start: the bundle executable with no arguments and without the debug-port variable. The message is shown by the caller's box.
export async function failOpen(appBundle, io) {
  // A start already happened in this run (launch.mjs tags that rejection): the app is up, so start nothing.
  if (io.started) return 6;
  const env = { ...io.env };
  delete env.OMO_DESKTOP_REMOTE_DEBUGGING_PORT;
  const child = io.spawn(bundleExe(appBundle), [], { env, detached: true, stdio: 'ignore' });
  child.on('error', (err) => io.onError(err));
  child.unref();
  io.messageBox();
  return 20;
}

async function runBoot(appBundle, flags) {
  try {
    const { main } = await import('./launch.mjs');
    return await main(flags);
  } catch (err) {
    console.error(`boot: ${err.message}`);
    const { spawn } = await import('node:child_process');
    const box = () => {
      const child = spawn('osascript', BOX_ARGS, { stdio: 'ignore', detached: true });
      child.on('error', (e) => console.error(`boot: message box failed: ${e.message}`));
      child.unref();
    };
    return failOpen(appBundle, {
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
  const fs = await import('node:fs');
  // realpath on both sides: on macOS the temp folder /var is a link to /private/var.
  return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (await isEntry()) {
  const [appBundle = '', ...flags] = process.argv.slice(2);
  process.exitCode = await runBoot(appBundle, flags);
}
