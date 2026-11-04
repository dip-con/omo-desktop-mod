// Windows shell links (.lnk) read and written through PowerShell and an inline C# shim over IShellLinkW,
// IPersistFile and IPropertyStore. Paths and payloads travel in environment variables as JSON, never inside the
// script text. Several paths are read per PowerShell call so the C# compiles once per call. Every spawn is async and
// bounded by a timeout of at most 30 s; a timed-out process tree is killed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const APP_USER_MODEL_ID = 'com.omo.desktop';
const MAX_SPAWN_MS = 30000;

// PROPERTYKEY for System.AppUserModel.ID is {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5. VT_LPWSTR is 31.
const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct OmoKey { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct OmoVariant {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr ptr;
}

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class OmoShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOmoShellLink {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr data, uint flags);
  void GetIDList(out IntPtr list);
  void SetIDList(IntPtr list);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
  void GetHotkey(out short key);
  void SetHotkey(short key);
  void GetShowCmd(out int show);
  void SetShowCmd(int show);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string file, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string rel, uint reserved);
  void Resolve(IntPtr hwnd, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOmoPersistFile {
  void GetClassID(out Guid id);
  [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
  void GetCurFile(out IntPtr file);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOmoPropertyStore {
  void GetCount(out uint count);
  void GetAt(uint index, out OmoKey key);
  void GetValue(ref OmoKey key, out OmoVariant value);
  void SetValue(ref OmoKey key, ref OmoVariant value);
  void Commit();
}

public sealed class OmoLinkData {
  public string Target, Args, WorkDir, IconPath, Description, Aumid;
  public int IconIndex;
}

public static class OmoLnk {
  static readonly OmoKey AumidKey = new OmoKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };

  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref OmoVariant value);

  public static OmoLinkData Read(string file) {
    var link = (IOmoShellLink)new OmoShellLink();
    ((IOmoPersistFile)link).Load(file, 0);
    var data = new OmoLinkData();
    var sb = new StringBuilder(4096);
    link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
    data.Target = sb.ToString();
    sb = new StringBuilder(4096);
    link.GetArguments(sb, sb.Capacity);
    data.Args = sb.ToString();
    sb = new StringBuilder(4096);
    link.GetWorkingDirectory(sb, sb.Capacity);
    data.WorkDir = sb.ToString();
    sb = new StringBuilder(4096);
    link.GetDescription(sb, sb.Capacity);
    data.Description = sb.ToString();
    sb = new StringBuilder(4096);
    int index;
    link.GetIconLocation(sb, sb.Capacity, out index);
    data.IconPath = sb.ToString();
    data.IconIndex = index;
    var key = AumidKey;
    OmoVariant value;
    ((IOmoPropertyStore)link).GetValue(ref key, out value);
    data.Aumid = value.vt == 31 ? Marshal.PtrToStringUni(value.ptr) : "";
    PropVariantClear(ref value);
    return data;
  }

  public static void Write(string file, bool create, string target, string args, string workDir,
      string iconPath, int iconIndex, string description, string aumid) {
    var link = (IOmoShellLink)new OmoShellLink();
    var persist = (IOmoPersistFile)link;
    if (!create) persist.Load(file, 2);
    link.SetPath(target);
    link.SetArguments(args ?? "");
    link.SetWorkingDirectory(workDir);
    link.SetIconLocation(iconPath, iconIndex);
    if (description != null) link.SetDescription(description);
    if (!string.IsNullOrEmpty(aumid)) {
      var key = AumidKey;
      var value = new OmoVariant();
      value.vt = 31;
      value.ptr = Marshal.StringToCoTaskMemUni(aumid);
      try {
        ((IOmoPropertyStore)link).SetValue(ref key, ref value);
        ((IOmoPropertyStore)link).Commit();
      } finally {
        PropVariantClear(ref value);
      }
    }
    persist.Save(file, true);
  }
}
"@
$lines = New-Object System.Collections.Generic.List[string]
$items = @(ConvertFrom-Json $env:OMO_LNK_BATCH | ForEach-Object { $_ })
foreach ($item in $items) {
  $p = if ($item -is [string]) { [string]$item } else { [string]$item.path }
  try {
    if ($env:OMO_LNK_OP -eq 'read') {
      $d = [OmoLnk]::Read($p)
      $out = [ordered]@{ path = $p; error = $null; target = $d.Target; args = $d.Args; workDir = $d.WorkDir; iconPath = $d.IconPath; iconIndex = $d.IconIndex; description = $d.Description; aumid = $d.Aumid }
    } else {
      [OmoLnk]::Write($p, [bool]$item.create, [string]$item.target, [string]$item.args, [string]$item.workDir, [string]$item.iconPath, [int]$item.iconIndex, $item.description, [string]$item.aumid)
      $out = [ordered]@{ path = $p; error = $null }
    }
  } catch {
    $out = [ordered]@{ path = $p; error = $_.Exception.Message }
  }
  $lines.Add(($out | ConvertTo-Json -Compress))
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join [char]10) + [char]10)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

// One PowerShell process per call. op is 'read' or 'write'; writePaths names the .lnk files a write changes.
function runPowerShell({ op, payload, writePaths = [] }) {
  const env = { ...process.env, OMO_LNK_OP: op, OMO_LNK_BATCH: JSON.stringify(payload) };
  if (writePaths.length > 0) env.OMO_LNK_WRITE_PATHS = JSON.stringify(writePaths);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, MAX_SPAWN_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`PowerShell did not finish within ${MAX_SPAWN_MS} ms`));
      else if (code !== 0) reject(new Error(`PowerShell exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

function parseRows(stdout, expected) {
  const rows = stdout.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  if (rows.length !== expected) throw new Error(`PowerShell returned ${rows.length} rows for ${expected} items`);
  return rows;
}

// One info object per input path, in input order. A missing file is {exists: false} and never reaches PowerShell.
// An unreadable file carries error; its other fields are absent.
export async function readLinks(paths) {
  const present = paths.filter((p) => fs.existsSync(p));
  const rows = present.length === 0
    ? []
    : parseRows(await runPowerShell({ op: 'read', payload: present }), present.length);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  return paths.map((p) => {
    const row = byPath.get(p);
    if (!row) return { path: p, exists: false };
    if (row.error) return { path: p, exists: true, error: row.error };
    return {
      path: p,
      exists: true,
      error: null,
      target: row.target,
      args: row.args,
      workdir: row.workDir,
      icon: `${row.iconPath},${row.iconIndex}`,
      description: row.description,
      aumid: row.aumid,
    };
  });
}

export async function readLink(p) {
  const [info] = await readLinks([p]);
  return info;
}

// Creates (create: true, file must not exist) or retargets (create: false, file must exist) one shortcut.
// aumid null or '' writes no AUMID; description null leaves the existing description unchanged.
export async function writeLink(spec) {
  const exists = fs.existsSync(spec.path);
  if (spec.create && exists) throw new Error(`refusing to create over an existing shortcut: ${spec.path}`);
  if (!spec.create && !exists) throw new Error(`no shortcut to retarget: ${spec.path}`);
  const payload = {
    path: spec.path,
    create: spec.create,
    target: spec.target,
    args: spec.args ?? '',
    workDir: spec.workDir,
    iconPath: spec.iconPath,
    iconIndex: spec.iconIndex ?? 0,
    description: spec.description ?? null,
    aumid: spec.aumid ?? '',
  };
  const [row] = parseRows(await runPowerShell({ op: 'write', payload: [payload], writePaths: [spec.path] }), 1);
  if (row.error) throw new Error(`shortcut ${spec.path} not written: ${row.error}`);
}

// 'mod': targets wscript.exe and launches a launch.vbs. 'plain': targets <appDir>\OmO.exe with no arguments.
// 'other': anything else, including an unreadable file. 'missing': no file.
export function classify(info, appDir) {
  if (!info.exists) return 'missing';
  if (info.error) return 'other';
  const target = path.win32.normalize(info.target ?? '').toLowerCase();
  if (path.win32.basename(target) === 'wscript.exe' && /launch\.vbs/i.test(info.args ?? '')) return 'mod';
  const plainTarget = path.win32.normalize(path.win32.join(appDir, 'OmO.exe')).toLowerCase();
  if (target === plainTarget && (info.args ?? '') === '') return 'plain';
  return 'other';
}
