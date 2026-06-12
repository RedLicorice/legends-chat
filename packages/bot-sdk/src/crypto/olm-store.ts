import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem-backed snapshot of the bot's Olm machine state.
 *
 * The blob format is opaque to {@link OlmStore}. A higher-level wrapper encodes
 * a JSON-serialised dump of the underlying IndexedDB store into a `Uint8Array`
 * and hands it here for persistence (see plan INDEX R3 — the on-disk format is
 * a JSON snapshot, not a matrix-wasm pickle).
 *
 * Writes are atomic via tmp + rename to survive crashes mid-write: a partially
 * written `<path>.tmp` is never observable as `<path>`, and the previous
 * `<path>` contents are intact until the rename succeeds.
 */
export class OlmStore {
  constructor(private readonly filePath: string) {}

  /** True if the snapshot file exists on disk. */
  async exists(): Promise<boolean> {
    try {
      await stat(this.filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /** Load the snapshot blob, or null if the file does not exist. */
  async load(): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.filePath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Atomically persist the snapshot blob.
   *
   * Writes to `<filePath>.tmp` first, then renames to `<filePath>`. If the write
   * fails (disk full, permissions, crash) the original `<filePath>` is left
   * untouched.
   */
  async save(blob: Uint8Array): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    await writeFile(tmp, blob);
    await rename(tmp, this.filePath);
  }

  /**
   * Delete the snapshot file (and any stray tmp file). No-op if absent.
   */
  async reset(): Promise<void> {
    await this.unlinkIfExists(this.filePath);
    await this.unlinkIfExists(this.filePath + ".tmp");
  }

  private async unlinkIfExists(p: string): Promise<void> {
    try {
      await unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
