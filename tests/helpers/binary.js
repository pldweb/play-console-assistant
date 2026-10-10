/**
 * Generates small synthetic binary fixtures (PNG, JPEG, AAB/ZIP) so tests
 * exercise the real byte parsers without checking in binary files.
 */
import { deflateRawSync, crc32 } from 'node:zlib';

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function chunk(type, data) {
  const t = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Buffer.from([...t, ...data]));
  return [...be32(data.length), ...t, ...data, ...be32(crc >>> 0)];
}

/** colorType: 2 = RGB, 6 = RGBA. `trns` adds a tRNS chunk. */
export function makePng(width, height, { colorType = 2, bitDepth = 8, trns = false, padTo = 0 } = {}) {
  const ihdr = [...be32(width), ...be32(height), bitDepth, colorType, 0, 0, 0];
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr)];
  if (trns) bytes.push(...chunk('tRNS', [0, 0, 0, 0, 0, 0]));
  const idatLen = Math.max(1, padTo - bytes.length - 24);
  // Build IDAT with Buffer ops: spreading a large array overflows the stack.
  const idatData = Buffer.alloc(idatLen);
  const idat = Buffer.concat([Buffer.from(be32(idatLen)), Buffer.from('IDAT'), idatData,
    Buffer.from(be32(crc32(Buffer.concat([Buffer.from('IDAT'), idatData])) >>> 0))]);
  return new Uint8Array(Buffer.concat([Buffer.from(bytes), idat, Buffer.from(chunk('IEND', []))]));
}

export function makeJpeg(width, height) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]);
}

// --- protobuf encoding for aapt2 proto XML ---------------------------------
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const enc = (s) => [...Buffer.from(s, 'utf8')];
const ld = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];

export function makeProtoManifest({ packageName = 'com.acme.notes', versionCode = '1', versionName = '1.0' } = {}) {
  const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
  const attr = (name, value, ns = '') => ld(4, [...(ns ? ld(1, enc(ns)) : []), ...ld(2, enc(name)), ...ld(3, enc(value))]);
  const element = [
    ...ld(3, enc('manifest')),
    ...attr('versionCode', versionCode, ANDROID_NS),
    ...attr('versionName', versionName, ANDROID_NS),
    ...attr('package', packageName),
  ];
  return new Uint8Array(ld(1, element));
}

/** Builds a ZIP. entries: [{ name, data:Uint8Array, deflate?:boolean }] */
export function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc(e.name);
    const data = e.deflate ? [...deflateRawSync(Buffer.from(e.data))] : [...e.data];
    const method = e.deflate ? 8 : 0;
    const crc = crc32(Buffer.from(e.data)) >>> 0;
    const header = [...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(e.data.length), ...le16(name.length), ...le16(0), ...name];
    local.push(...header, ...data);
    central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(e.data.length), ...le16(name.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name);
    offset += header.length + data.length;
  }
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length),
    ...le32(central.length), ...le32(offset), ...le16(0)];
  return new Uint8Array([...local, ...central, ...eocd]);
}

export function makeAab({ packageName = 'com.acme.notes', versionCode = '1', deflate = true, includeBundleConfig = true, signed = true } = {}) {
  const entries = [
    { name: 'base/manifest/AndroidManifest.xml', data: makeProtoManifest({ packageName, versionCode }), deflate },
    { name: 'base/dex/classes.dex', data: new Uint8Array([0x64, 0x65, 0x78, 0x0a]) },
  ];
  if (includeBundleConfig) entries.push({ name: 'BundleConfig.pb', data: new Uint8Array([0x0a, 0x00]) });
  if (signed) entries.push({ name: 'META-INF/MANIFEST.MF', data: new Uint8Array(enc('Manifest-Version: 1.0\n')) });
  return makeZip(entries);
}
