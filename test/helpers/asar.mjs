// Builds a minimal asar with the header layout the loader reads (bytes 12-15 header length, JSON from 16,
// data at 8 + UInt32LE(4)). Test-only: never reads or writes a real install.
export function makeAsar(files) {
  const header = { files: {} };
  const datas = [];
  let off = 0;
  for (const [name, buf] of Object.entries(files)) {
    header.files[name] = { size: buf.length, offset: String(off) };
    datas.push(buf);
    off += buf.length;
  }
  let json = Buffer.from(JSON.stringify(header));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + json.length, 4);
  head.writeUInt32LE(4 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json, ...datas]);
}
