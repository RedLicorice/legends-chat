import { describe, it, expect } from "vitest";
import { sniffImageMime, hasImageMetadata } from "@/lib/image-metadata";

// Minimal-but-structurally-valid containers. The scanner never decodes pixels,
// so a correct chunk/segment table is all that's needed.

function jpeg(segments: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    ...segments,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), // SOS
    Buffer.from([0x00, 0x11, 0x22]), // entropy-coded data
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not verified
}

function png(extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13)),
    ...extra,
    pngChunk("IDAT", Buffer.alloc(4)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webp(extra: Buffer[] = []): Buffer {
  const body = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    webpChunk("VP8 ", Buffer.alloc(10)),
    ...extra,
  ]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function gifExtension(label: number, subBlocks: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x21, label])];
  for (const b of subBlocks) parts.push(Buffer.from([b.length]), b);
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function gif(extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]), // LSD, no GCT
    ...extra,
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00]), // image descriptor
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]), // LZW min code size + data + terminator
    Buffer.from([0x3b]), // trailer
  ]);
}

describe("sniffImageMime", () => {
  it("identifies each supported container from its magic bytes", () => {
    expect(sniffImageMime(jpeg())).toBe("image/jpeg");
    expect(sniffImageMime(png())).toBe("image/png");
    expect(sniffImageMime(gif())).toBe("image/gif");
    expect(sniffImageMime(webp())).toBe("image/webp");
  });

  it("returns null for anything else", () => {
    expect(sniffImageMime(Buffer.from("<svg xmlns='...'></svg>"))).toBeNull();
    expect(sniffImageMime(Buffer.from([0x00]))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("hasImageMetadata — fail closed (cr-c1)", () => {
  it("rejects a JPEG handed to the PNG scanner instead of reporting it clean", () => {
    // The exact bypass: declare image/png, send JPEG bytes.
    const scan = hasImageMetadata(jpeg([jpegSegment(0xe1, Buffer.from("Exif\0\0GPS", "binary"))]), "image/png");
    expect(scan.malformed).toBe(true);
    expect(scan.blocking).toBe(true);
  });

  it("rejects an unknown container type", () => {
    expect(hasImageMetadata(Buffer.from("whatever"), "image/svg+xml").blocking).toBe(true);
  });

  it("rejects truncated containers", () => {
    expect(hasImageMetadata(png().subarray(0, 30), "image/png").malformed).toBe(true);
    expect(hasImageMetadata(jpeg().subarray(0, 2), "image/jpeg").malformed).toBe(true);
    expect(hasImageMetadata(gif().subarray(0, 14), "image/gif").malformed).toBe(true);
    expect(hasImageMetadata(webp().subarray(0, 14), "image/webp").malformed).toBe(true);
  });

  it("accepts clean containers", () => {
    for (const [buf, mime] of [[jpeg(), "image/jpeg"], [png(), "image/png"], [gif(), "image/gif"], [webp(), "image/webp"]] as const) {
      const scan = hasImageMetadata(buf as Buffer, mime);
      expect(scan.malformed, mime).toBe(false);
      expect(scan.blocking, mime).toBe(false);
    }
  });
});

describe("hasImageMetadata — detection coverage", () => {
  it("flags JPEG Exif, XMP, IPTC, MPF, COM and vendor APP segments", () => {
    const cases: [number, Buffer, string][] = [
      [0xe1, Buffer.from("Exif\0\0rest", "binary"), "exif"],
      [0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x/>", "binary"), "xmp"],
      [0xe1, Buffer.from("http://ns.adobe.com/xmp/extension/\0<x/>", "binary"), "xmp"],
      [0xed, Buffer.from("Photoshop 3.0\0stuff", "binary"), "iptc"],
      [0xe2, Buffer.from("MPF\0stuff", "binary"), "mpf"],
      [0xfe, Buffer.from("shot on a phone", "binary"), "comment"],
      [0xe4, Buffer.from("makernote", "binary"), "appdata"],
    ];
    for (const [marker, payload, kind] of cases) {
      const scan = hasImageMetadata(jpeg([jpegSegment(marker, payload)]), "image/jpeg");
      expect(scan.kinds, kind).toContain(kind);
      expect(scan.blocking, kind).toBe(true);
    }
  });

  it("detects ICC in every format but does not block on it (cr-l13)", () => {
    const j = hasImageMetadata(jpeg([jpegSegment(0xe2, Buffer.from("ICC_PROFILE\0data", "binary"))]), "image/jpeg");
    expect(j.kinds).toEqual(["icc"]);
    expect(j.blocking).toBe(false);

    const p = hasImageMetadata(png([pngChunk("iCCP", Buffer.from("sRGB\0\0x"))]), "image/png");
    expect(p.kinds).toEqual(["icc"]);
    expect(p.blocking).toBe(false);

    const w = hasImageMetadata(webp([webpChunk("ICCP", Buffer.from("profile"))]), "image/webp");
    expect(w.kinds).toEqual(["icc"]);
    expect(w.blocking).toBe(false);
  });

  it("flags PNG text chunks and eXIf", () => {
    const scan = hasImageMetadata(
      png([pngChunk("tEXt", Buffer.from("Comment\0hi")), pngChunk("eXIf", Buffer.alloc(8))]),
      "image/png",
    );
    expect(scan.kinds.sort()).toEqual(["exif", "text"]);
    expect(scan.blocking).toBe(true);
  });

  it("flags WebP EXIF/XMP chunks", () => {
    const scan = hasImageMetadata(webp([webpChunk("EXIF", Buffer.alloc(9))]), "image/webp");
    expect(scan.kinds).toEqual(["exif"]);
    expect(scan.blocking).toBe(true);
  });

  it("walks GIF extension blocks: comments and XMP block, animation does not", () => {
    const comment = hasImageMetadata(gif([gifExtension(0xfe, [Buffer.from("made with x")])]), "image/gif");
    expect(comment.kinds).toContain("comment");
    expect(comment.blocking).toBe(true);

    const xmp = hasImageMetadata(
      gif([gifExtension(0xff, [Buffer.from("XMP DataXMP", "ascii"), Buffer.from("<x/>")])]),
      "image/gif",
    );
    expect(xmp.kinds).toContain("xmp");

    // NETSCAPE2.0 loop control + graphic control are on every animated GIF.
    const animated = hasImageMetadata(
      gif([
        gifExtension(0xff, [Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([0x01, 0x00, 0x00])]),
        gifExtension(0xf9, [Buffer.from([0x04, 0x0a, 0x00, 0x00, 0x00])]),
      ]),
      "image/gif",
    );
    expect(animated.kinds).toEqual([]);
    expect(animated.blocking).toBe(false);
  });
});
