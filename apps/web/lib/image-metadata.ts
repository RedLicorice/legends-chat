// Byte-level metadata scanner + magic-byte MIME sniffer.
//
// SECURITY (cr-c1): this module is the server-side half of the "we verify
// EXIF/GPS is gone" claim. Two properties matter and both used to be missing:
//
//   1. The caller must dispatch on the *sniffed* container type, never on the
//      client-declared multipart Content-Type. `sniffImageMime` exists for
//      exactly that — see apps/web/app/api/upload/route.ts.
//   2. The scanners FAIL CLOSED. A container that doesn't parse cleanly is
//      reported as `{ blocking: true, kinds: ["malformed"] }` rather than
//      "nothing found". Previously a signature mismatch or a truncated segment
//      table returned `{found:false}`, so declaring `image/png` on a
//      GPS-tagged JPEG sailed straight through the PNG scanner.
//
// Fail-closed is safe here because the normal upload path re-encodes JPEG/PNG
// through a canvas before sending (apps/web/lib/upload.ts), so a legitimate
// image is always a clean, freshly-serialized container. GIF/WebP pass through
// unmodified, which is why their walkers below tolerate the structures real
// encoders actually emit (see the NETSCAPE2.0 note in `scanGif`).

export type MetadataScan = {
  /** True when any metadata kind at all was detected (including non-blocking). */
  found: boolean;
  kinds: string[];
  /** True when the upload must be rejected. See `NON_BLOCKING_KINDS` below. */
  blocking: boolean;
  /** True when the container itself failed to parse — always also `blocking`. */
  malformed: boolean;
};

const MAX_SEGMENTS = 1000;

/**
 * Kinds that are detected and reported but do NOT reject the upload.
 *
 * `icc` is a colour profile, not identifying metadata. It is surfaced so the
 * scanner no longer silently misses it (cr-l13), but it is not blocking:
 * Safari/iOS embeds a display colour profile in `canvas.toBlob()` output, so
 * rejecting on ICC would break ordinary photo uploads from the PWA's main
 * target platform. Everything else below is identifying and blocks.
 */
const NON_BLOCKING_KINDS = new Set(["icc"]);

function malformed(reason: string): MetadataScan {
  return { found: true, kinds: [`malformed:${reason}`], blocking: true, malformed: true };
}

function result(kinds: Set<string>): MetadataScan {
  const list = [...kinds];
  return {
    found: list.length > 0,
    kinds: list,
    blocking: list.some((k) => !NON_BLOCKING_KINDS.has(k)),
    malformed: false,
  };
}

// ── Magic-byte sniffing ───────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Canonical image MIME derived from the leading bytes, or null when the buffer
 * is not one of the four containers we accept. NEVER trust a client-declared
 * MIME in place of this.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return "image/png";
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * `mime` MUST be the value returned by `sniffImageMime` for the same buffer.
 * An unknown type is treated as a rejection, not as "clean".
 */
export function hasImageMetadata(buf: Buffer, mime: string): MetadataScan {
  try {
    switch (mime) {
      case "image/jpeg": return scanJpeg(buf);
      case "image/png": return scanPng(buf);
      case "image/webp": return scanWebp(buf);
      case "image/gif": return scanGif(buf);
      default: return malformed("unsupported-container");
    }
  } catch {
    // Any indexing/parse blowup is a malformed container — fail closed.
    return malformed("parse-error");
  }
}

// ── JPEG ──────────────────────────────────────────────────────────────────────

function ascii(payload: Buffer, len: number): string {
  return payload.subarray(0, len).toString("ascii");
}

function scanJpeg(buf: Buffer): MetadataScan {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return malformed("jpeg-signature");
  }
  const kinds = new Set<string>();
  let i = 2;
  let segs = 0;
  let sawSos = false;
  while (segs < MAX_SEGMENTS) {
    if (i + 1 >= buf.length) return malformed("jpeg-truncated");
    if (buf[i] !== 0xff) return malformed("jpeg-marker-desync");
    // skip fill bytes
    let m = buf[i + 1];
    while (m === 0xff && i + 1 < buf.length) {
      i++;
      m = buf[i + 1];
    }
    if (m === undefined) return malformed("jpeg-truncated");
    // standalone markers without payload
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      segs++;
      continue;
    }
    if (m === 0xda) { sawSos = true; break; } // SOS — entropy-coded data follows
    if (i + 4 > buf.length) return malformed("jpeg-truncated");
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return malformed("jpeg-segment-length");
    const payloadStart = i + 4;
    const payloadEnd = i + 2 + len;
    const payload = buf.subarray(payloadStart, payloadEnd);
    if (m === 0xe1) {
      // APP1
      if (payload.length >= 6 && ascii(payload, 6) === "Exif\0\0") {
        kinds.add("exif");
      } else if (payload.length >= 29 && ascii(payload, 28) === "http://ns.adobe.com/xap/1.0/" && payload[28] === 0x00) {
        kinds.add("xmp");
      } else if (payload.length >= 35 && ascii(payload, 35) === "http://ns.adobe.com/xmp/extension/\0") {
        // Extended XMP — the overflow container for >64 KiB XMP packets.
        kinds.add("xmp");
      }
    } else if (m === 0xe2) {
      // APP2: ICC colour profile, and Multi-Picture Format (phones stash a
      // second full-resolution JPEG here — with its own Exif/GPS inside).
      if (payload.length >= 12 && ascii(payload, 11) === "ICC_PROFILE" && payload[11] === 0x00) {
        kinds.add("icc");
      } else if (payload.length >= 4 && ascii(payload, 4) === "MPF\0") {
        kinds.add("mpf");
      }
    } else if (m === 0xed) {
      // APP13 Photoshop/IPTC
      if (payload.length >= 14 && ascii(payload, 13) === "Photoshop 3.0" && payload[13] === 0x00) {
        kinds.add("iptc");
      }
    } else if (m === 0xfe) {
      // COM — free-form comment, frequently carries tool/camera strings.
      kinds.add("comment");
    } else if (m >= 0xe4 && m <= 0xec) {
      // APP4..APP12: vendor maker-note and metadata containers (Ducky, FPXR,
      // Samsung/Canon extensions…). Canvas re-encoding never emits these.
      kinds.add("appdata");
    }
    i = payloadEnd;
    segs++;
  }
  if (!sawSos) return malformed("jpeg-no-sos");
  return result(kinds);
}

// ── PNG ───────────────────────────────────────────────────────────────────────

function scanPng(buf: Buffer): MetadataScan {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return malformed("png-signature");
  }
  const kinds = new Set<string>();
  let i = 8;
  let segs = 0;
  let sawIhdr = false;
  let sawIend = false;
  while (segs < MAX_SEGMENTS) {
    if (i + 8 > buf.length) return malformed("png-truncated");
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) return malformed("png-chunk-type");
    const next = i + 8 + len + 4; // header + data + CRC
    if (next > buf.length || next < i) return malformed("png-chunk-length");
    if (segs === 0) {
      if (type !== "IHDR") return malformed("png-no-ihdr");
      sawIhdr = true;
    }
    if (type === "tEXt") kinds.add("text");
    else if (type === "zTXt") kinds.add("ztxt");
    else if (type === "iTXt") kinds.add("itxt");
    else if (type === "eXIf") kinds.add("exif");
    else if (type === "iCCP") kinds.add("icc");
    if (type === "IEND") { sawIend = true; break; }
    i = next;
    segs++;
  }
  if (!sawIhdr || !sawIend) return malformed("png-incomplete");
  return result(kinds);
}

// ── WebP ──────────────────────────────────────────────────────────────────────

function scanWebp(buf: Buffer): MetadataScan {
  if (buf.length < 12) return malformed("webp-truncated");
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return malformed("webp-signature");
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return malformed("webp-signature");
  const riffSize = buf.readUInt32LE(4);
  // The RIFF size counts everything after the 8-byte RIFF header.
  const end = 8 + riffSize;
  if (riffSize < 4 || end > buf.length) return malformed("webp-riff-size");
  const kinds = new Set<string>();
  let i = 12;
  let segs = 0;
  while (segs < MAX_SEGMENTS && i < end) {
    if (i + 8 > end) return malformed("webp-truncated");
    const fourcc = buf.subarray(i, i + 4).toString("ascii");
    const len = buf.readUInt32LE(i + 4);
    let next = i + 8 + len;
    if (len % 2 === 1) next += 1; // chunks are padded to an even size
    if (next > end || next < i) return malformed("webp-chunk-length");
    if (fourcc === "EXIF") kinds.add("exif");
    else if (fourcc === "XMP ") kinds.add("xmp");
    else if (fourcc === "ICCP") kinds.add("icc");
    i = next;
    segs++;
  }
  if (i !== end) return malformed("webp-chunk-walk");
  return result(kinds);
}

// ── GIF ───────────────────────────────────────────────────────────────────────

// Application Extension identifiers that carry no metadata — they exist purely
// to drive animation and are present in essentially every animated GIF, so
// flagging them would reject the entire `gifs` bucket.
const BENIGN_GIF_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

function scanGif(buf: Buffer): MetadataScan {
  if (buf.length < 13) return malformed("gif-truncated");
  const sig = buf.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return malformed("gif-signature");

  const kinds = new Set<string>();
  // Logical Screen Descriptor is 7 bytes (6..12), then an optional Global
  // Color Table sized by the low 3 bits of the packed field.
  const packed = buf[10]!;
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));

  // Walk length-prefixed sub-blocks, returning the offset just past the
  // terminating zero-length block. Every iteration advances `p` by at least
  // one byte, so this terminates without an artificial iteration cap (image
  // data for a large frame is thousands of 255-byte sub-blocks).
  const skipSubBlocks = (start: number): number => {
    let p = start;
    while (p < buf.length) {
      const size = buf[p]!;
      p += 1;
      if (size === 0) return p;
      p += size;
      if (p > buf.length) return -1;
    }
    return -1;
  };

  let blocks = 0;
  let sawTrailer = false;
  // Each iteration advances `i` by at least one byte; the cap is just a
  // belt-and-braces bound, generous enough for long animations.
  while (blocks < buf.length) {
    if (i >= buf.length) return malformed("gif-truncated");
    const introducer = buf[i]!;
    if (introducer === 0x3b) { sawTrailer = true; break; } // trailer
    if (introducer === 0x21) {
      // Extension block: introducer, label, then sub-blocks.
      if (i + 2 > buf.length) return malformed("gif-truncated");
      const label = buf[i + 1]!;
      let p = i + 2;
      if (label === 0xff) {
        // Application Extension: first sub-block is an 11-byte identifier.
        if (p >= buf.length) return malformed("gif-truncated");
        const idLen = buf[p]!;
        if (p + 1 + idLen > buf.length) return malformed("gif-truncated");
        const appId = buf.subarray(p + 1, p + 1 + idLen).toString("ascii");
        if (appId.startsWith("XMP Data")) kinds.add("xmp");
        else if (appId.startsWith("ICCRGBG1")) kinds.add("icc");
        else if (!BENIGN_GIF_APPS.has(appId)) kinds.add("application");
      } else if (label === 0xfe) {
        kinds.add("comment");
      } else if (label === 0x01) {
        kinds.add("plaintext");
      } else if (label !== 0xf9) {
        // 0xF9 is the Graphic Control Extension (timing/transparency) — benign.
        kinds.add("extension");
      }
      p = skipSubBlocks(p);
      if (p < 0) return malformed("gif-subblocks");
      i = p;
    } else if (introducer === 0x2c) {
      // Image Descriptor: 10 bytes, optional Local Color Table, LZW min code
      // size, then the image data sub-blocks.
      if (i + 10 > buf.length) return malformed("gif-truncated");
      const lpacked = buf[i + 9]!;
      let p = i + 10;
      if (lpacked & 0x80) p += 3 * (1 << ((lpacked & 0x07) + 1));
      p += 1; // LZW minimum code size
      if (p > buf.length) return malformed("gif-truncated");
      p = skipSubBlocks(p);
      if (p < 0) return malformed("gif-subblocks");
      i = p;
    } else {
      return malformed("gif-block-introducer");
    }
    blocks++;
  }
  if (!sawTrailer) return malformed("gif-no-trailer");
  return result(kinds);
}
