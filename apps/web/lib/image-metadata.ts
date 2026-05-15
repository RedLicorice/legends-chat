// Byte-level metadata scanner. Defense in depth — client should have stripped
// already. Returns the kinds it found so the server can report back what
// tripped it. Defensive: malformed/truncated input returns no findings rather
// than throwing.

export type MetadataScan = { found: boolean; kinds: string[] };

const MAX_SEGMENTS = 1000;

export function hasImageMetadata(buf: Buffer, mime: string): MetadataScan {
  try {
    switch (mime) {
      case "image/jpeg": return scanJpeg(buf);
      case "image/png": return scanPng(buf);
      case "image/webp": return scanWebp(buf);
      default: return { found: false, kinds: [] };
    }
  } catch {
    return { found: false, kinds: [] };
  }
}

function scanJpeg(buf: Buffer): MetadataScan {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return { found: false, kinds: [] };
  }
  const kinds = new Set<string>();
  let i = 2;
  let segs = 0;
  while (i < buf.length - 1 && segs < MAX_SEGMENTS) {
    if (buf[i] !== 0xff) break;
    // skip fill bytes
    let m = buf[i + 1];
    while (m === 0xff && i + 1 < buf.length) {
      i++;
      m = buf[i + 1];
    }
    if (m === undefined) break;
    // standalone markers without payload
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      segs++;
      continue;
    }
    if (m === 0xda) break; // SOS — image data follows
    if (i + 4 > buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;
    const payloadStart = i + 4;
    const payloadEnd = i + 2 + len;
    const payload = buf.subarray(payloadStart, payloadEnd);
    if (m === 0xe1) {
      if (payload.length >= 6 && payload[0] === 0x45 && payload[1] === 0x78 && payload[2] === 0x69 && payload[3] === 0x66 && payload[4] === 0x00 && payload[5] === 0x00) {
        kinds.add("exif");
      } else if (payload.length >= 29 && payload.subarray(0, 28).toString("ascii") === "http://ns.adobe.com/xap/1.0/" && payload[28] === 0x00) {
        kinds.add("xmp");
      }
    } else if (m === 0xed) {
      if (payload.length >= 14 && payload.subarray(0, 13).toString("ascii") === "Photoshop 3.0" && payload[13] === 0x00) {
        kinds.add("iptc");
      }
    }
    i = payloadEnd;
    segs++;
  }
  return { found: kinds.size > 0, kinds: [...kinds] };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function scanPng(buf: Buffer): MetadataScan {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return { found: false, kinds: [] };
  }
  const kinds = new Set<string>();
  let i = 8;
  let segs = 0;
  while (i + 8 <= buf.length && segs < MAX_SEGMENTS) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("ascii");
    const next = i + 8 + len + 4;
    if (next > buf.length) break;
    if (type === "tEXt") kinds.add("text");
    else if (type === "zTXt") kinds.add("ztxt");
    else if (type === "iTXt") kinds.add("itxt");
    else if (type === "eXIf") kinds.add("exif");
    if (type === "IEND") break;
    i = next;
    segs++;
  }
  return { found: kinds.size > 0, kinds: [...kinds] };
}

function scanWebp(buf: Buffer): MetadataScan {
  if (buf.length < 12) return { found: false, kinds: [] };
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return { found: false, kinds: [] };
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return { found: false, kinds: [] };
  const kinds = new Set<string>();
  let i = 12;
  let segs = 0;
  while (i + 8 <= buf.length && segs < MAX_SEGMENTS) {
    const fourcc = buf.subarray(i, i + 4).toString("ascii");
    const len = buf.readUInt32LE(i + 4);
    let next = i + 8 + len;
    if (len % 2 === 1) next += 1; // pad to even
    if (next > buf.length) break;
    if (fourcc === "EXIF") kinds.add("exif");
    else if (fourcc === "XMP ") kinds.add("xmp");
    i = next;
    segs++;
  }
  return { found: kinds.size > 0, kinds: [...kinds] };
}
