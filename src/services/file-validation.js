/**
 * Byte-level file inspection and role validation.
 *
 * File type is decided from the file's bytes (magic numbers and headers),
 * never from its name or extension alone. Requirements come from Play
 * Console Help "Add preview assets" (see docs/PLATFORM_AUDIT.md).
 */

export const IMAGE_RULES = Object.freeze({
  appIcon: { formats: ['png'], width: 512, height: 512, maxBytes: 1024 * 1024, requireAlpha: 'warn' },
  featureGraphic: { formats: ['png', 'jpeg'], width: 1024, height: 500, forbidAlpha: true },
  phoneScreenshots: { formats: ['png', 'jpeg'], minSide: 320, maxSide: 3840, maxRatio: 2, forbidAlpha: true },
  tablet7Screenshots: { formats: ['png', 'jpeg'], minSide: 320, maxSide: 3840, maxRatio: 2, forbidAlpha: true, recommendedMinSide: 1080 },
  tablet10Screenshots: { formats: ['png', 'jpeg'], minSide: 320, maxSide: 3840, maxRatio: 2, forbidAlpha: true, recommendedMinSide: 1080 },
});

// Play Help does not state a byte limit for screenshots/feature graphic on
// the audited page; warn above this size instead of guessing a hard limit.
const LARGE_IMAGE_WARN_BYTES = 8 * 1024 * 1024;

const u8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));

export function sniffType(buf) {
  const b = u8(buf);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  return 'unknown';
}

const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Parses PNG IHDR plus presence of a tRNS chunk. */
export function parsePng(buf) {
  const b = u8(buf);
  if (sniffType(b) !== 'png') throw new Error('Not a PNG file.');
  if (b.length < 33 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') throw new Error('PNG header is missing or corrupt.');
  const width = be32(b, 16);
  const height = be32(b, 20);
  const bitDepth = b[24];
  const colorType = b[25];
  let hasTrns = false;
  let off = 8;
  while (off + 8 <= b.length) {
    const len = be32(b, off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (type === 'tRNS') hasTrns = true;
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  const hasAlpha = colorType === 4 || colorType === 6 || hasTrns;
  return { format: 'png', width, height, bitDepth, colorType, hasAlpha, is32BitRgba: colorType === 6 && bitDepth === 8 };
}

/** Reads the first SOFn marker to get JPEG dimensions. */
export function parseJpeg(buf) {
  const b = u8(buf);
  if (sniffType(b) !== 'jpeg') throw new Error('Not a JPEG file.');
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) { off += 1; continue; }
    const marker = b[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = (b[off + 2] << 8) | b[off + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (off + 9 > b.length) break;
      return { format: 'jpeg', height: (b[off + 5] << 8) | b[off + 6], width: (b[off + 7] << 8) | b[off + 8], hasAlpha: false };
    }
    if (marker === 0xda) break; // start of scan without SOF: corrupt
    off += 2 + len;
  }
  throw new Error('JPEG dimensions could not be read.');
}

export function inspectImage(buf) {
  const t = sniffType(buf);
  if (t === 'png') return parsePng(buf);
  if (t === 'jpeg') return parseJpeg(buf);
  throw new Error('File is not a PNG or JPEG image (checked file contents).');
}

/**
 * Validates an image for an asset role.
 * @returns {{ ok:boolean, errors:string[], warnings:string[], info: object|null }}
 */
export function validateImageForRole(role, buf, { fileName = '' } = {}) {
  const rules = IMAGE_RULES[role];
  if (!rules) throw new Error(`Unknown image role ${role}`);
  const errors = [];
  const warnings = [];
  let info = null;
  try {
    info = inspectImage(buf);
  } catch (e) {
    return { ok: false, errors: [e.message], warnings, info: null };
  }
  const size = u8(buf).length;
  if (!rules.formats.includes(info.format)) errors.push(`Must be ${rules.formats.map((f) => f.toUpperCase()).join(' or ')}; file contents are ${info.format.toUpperCase()}.`);
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const extType = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'png' ? 'png' : null;
  if (extType && extType !== info.format) warnings.push(`File extension .${ext} does not match its ${info.format.toUpperCase()} contents.`);
  if (rules.width && (info.width !== rules.width || info.height !== rules.height)) {
    errors.push(`Must be ${rules.width} x ${rules.height} px; this file is ${info.width} x ${info.height} px.`);
  }
  if (rules.minSide) {
    const short = Math.min(info.width, info.height);
    const long = Math.max(info.width, info.height);
    if (short < rules.minSide || long > rules.maxSide) errors.push(`Each side must be between ${rules.minSide} and ${rules.maxSide} px; this file is ${info.width} x ${info.height} px.`);
    if (long > short * rules.maxRatio) errors.push(`The long side may be at most ${rules.maxRatio}x the short side; this file is ${info.width} x ${info.height} px.`);
    if (rules.recommendedMinSide && short < rules.recommendedMinSide) warnings.push(`Google recommends at least ${rules.recommendedMinSide} px for tablet screenshots.`);
  }
  if (rules.maxBytes && size > rules.maxBytes) errors.push(`Must be at most ${Math.round(rules.maxBytes / 1024)} KB; this file is ${Math.round(size / 1024)} KB.`);
  if (!rules.maxBytes && size > LARGE_IMAGE_WARN_BYTES) warnings.push('Large file; Play Console may reject it. Check the current size limit.');
  if (rules.forbidAlpha && info.hasAlpha) errors.push('Must not have an alpha (transparency) channel.');
  if (rules.requireAlpha === 'warn' && info.format === 'png' && !info.is32BitRgba) warnings.push('Play Console specifies a 32-bit PNG with alpha for the app icon.');
  return { ok: errors.length === 0, errors, warnings, info };
}

// ---------------------------------------------------------------------------
// ZIP / AAB
// ---------------------------------------------------------------------------

/** Reads the ZIP central directory. Returns entries with header offsets. */
export function readZipDirectory(buf) {
  const b = u8(buf);
  if (sniffType(b) !== 'zip') throw new Error('Not a ZIP archive.');
  // EOCD is in the last 22..(22+65535) bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found (file truncated?).');
  let count = le16(b, eocd + 10);
  let cdOffset = le32(b, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64: locator sits right before EOCD.
    const loc = eocd - 20;
    if (loc < 0 || le32(b, loc) !== 0x07064b50) throw new Error('ZIP64 locator missing.');
    const z64 = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(loc + 8, true));
    count = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(z64 + 32, true));
    cdOffset = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(z64 + 48, true));
  }
  const entries = [];
  let off = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (le32(b, off) !== 0x02014b50) throw new Error('ZIP central directory is corrupt.');
    const method = le16(b, off + 10);
    const compressedSize = le32(b, off + 20);
    const uncompressedSize = le32(b, off + 24);
    const nameLen = le16(b, off + 28);
    const extraLen = le16(b, off + 30);
    const commentLen = le16(b, off + 32);
    const localOffset = le32(b, off + 42);
    const name = dec.decode(b.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(buf, entry) {
  const b = u8(buf);
  const o = entry.localOffset;
  if (le32(b, o) !== 0x04034b50) throw new Error('ZIP local header is corrupt.');
  const start = o + 30 + le16(b, o + 26) + le16(b, o + 28);
  const data = b.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
}

// --- Minimal protobuf reader for aapt2's proto XML (Resources.proto) -------
function readVarint(b, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= b.length) throw new Error('Truncated varint.');
    const byte = b[pos.i++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 63) throw new Error('Varint too long.');
  }
}

function readFields(b) {
  const pos = { i: 0 };
  const fields = [];
  while (pos.i < b.length) {
    const key = readVarint(b, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) fields.push({ field, value: readVarint(b, pos) });
    else if (wire === 2) {
      const len = readVarint(b, pos);
      fields.push({ field, bytes: b.subarray(pos.i, pos.i + len) });
      pos.i += len;
    } else if (wire === 5) pos.i += 4;
    else if (wire === 1) pos.i += 8;
    else throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }
  return fields;
}

/**
 * Extracts manifest attributes from a proto XmlNode:
 *  XmlNode{ element=1 }, XmlElement{ name=3, attribute=4 },
 *  XmlAttribute{ namespace_uri=1, name=2, value=3 }.
 */
export function parseProtoManifest(bytes) {
  const dec = new TextDecoder();
  const node = readFields(bytes);
  const el = node.find((f) => f.field === 1 && f.bytes);
  if (!el) throw new Error('Manifest has no root element.');
  const elFields = readFields(el.bytes);
  const nameF = elFields.find((f) => f.field === 3 && f.bytes);
  if (!nameF || dec.decode(nameF.bytes) !== 'manifest') throw new Error('Root element is not <manifest>.');
  const attrs = {};
  for (const f of elFields.filter((x) => x.field === 4 && x.bytes)) {
    const af = readFields(f.bytes);
    const n = af.find((x) => x.field === 2 && x.bytes);
    const v = af.find((x) => x.field === 3 && x.bytes);
    if (n) attrs[dec.decode(n.bytes)] = v ? dec.decode(v.bytes) : '';
  }
  return attrs;
}

/**
 * Structural AAB check. A valid ZIP with the bundle files is necessary, not
 * sufficient: only Play Console processing can confirm a bundle is valid.
 */
export async function inspectAab(buf, { fileName = '' } = {}) {
  const errors = [];
  const warnings = [];
  const info = { format: 'aab', packageName: null, versionCode: null, versionName: null, modules: [] };
  if (!/\.aab$/i.test(fileName)) warnings.push('File name does not end in .aab.');
  if (sniffType(buf) !== 'zip') {
    errors.push('Not an Android App Bundle: file contents are not a ZIP archive.');
    return { ok: false, errors, warnings, info };
  }
  let entries;
  try {
    entries = readZipDirectory(buf);
  } catch (e) {
    errors.push(e.message);
    return { ok: false, errors, warnings, info };
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('BundleConfig.pb')) errors.push('BundleConfig.pb is missing; this looks like an APK or plain ZIP, not an App Bundle.');
  const manifestEntry = entries.find((e) => e.name === 'base/manifest/AndroidManifest.xml');
  if (!manifestEntry) errors.push('base/manifest/AndroidManifest.xml is missing.');
  info.modules = [...new Set(entries.map((e) => e.name.split('/')[0]).filter((n) => names.has(`${n}/manifest/AndroidManifest.xml`)))];
  if (manifestEntry) {
    try {
      const attrs = parseProtoManifest(await readZipEntry(buf, manifestEntry));
      info.packageName = attrs.package || null;
      info.versionCode = attrs.versionCode ? Number(attrs.versionCode) : null;
      info.versionName = attrs.versionName || null;
    } catch (e) {
      warnings.push(`Package name could not be read from the manifest (${e.message}). It will be checked in Play Console after upload.`);
    }
  }
  if (names.has('META-INF/MANIFEST.MF') === false) warnings.push('Bundle does not appear to be signed (no META-INF/MANIFEST.MF). Play requires an upload-key signature.');
  return { ok: errors.length === 0, errors, warnings, info };
}

export async function sha256Hex(buf) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', u8(buf));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Validates bytes for any role and returns a uniform result. */
export async function validateFileForRole(role, buf, { fileName = '' } = {}) {
  if (role === 'aabFile') return inspectAab(buf, { fileName });
  return validateImageForRole(role, buf, { fileName });
}
