import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OlmStore } from "../../src/crypto/olm-store.js";

describe("OlmStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "olm-store-"));
    storePath = path.join(dir, "olm-store.pickle");
  });

  afterEach(async () => {
    // Restore any chmod'd dir before cleanup so rm can recurse.
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the pickle file does not exist", async () => {
    const store = new OlmStore(storePath);
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("round-trips a save/load", async () => {
    const store = new OlmStore(storePath);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    await store.save(blob);
    expect(await store.exists()).toBe(true);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reset() deletes the pickle file", async () => {
    const store = new OlmStore(storePath);
    await store.save(new Uint8Array([9]));
    await store.reset();
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("reset() is a no-op when the pickle file does not exist", async () => {
    const store = new OlmStore(storePath);
    await expect(store.reset()).resolves.toBeUndefined();
    expect(await store.exists()).toBe(false);
  });

  it("save() is atomic — a leftover tmp file does not corrupt load", async () => {
    const store = new OlmStore(storePath);
    await store.save(new Uint8Array([42]));
    // Simulate a crash mid-write: a tmp file with garbage exists alongside.
    await writeFile(storePath + ".tmp", Buffer.from("garbage"));
    const loaded = await store.load();
    expect(Array.from(loaded!)).toEqual([42]);
  });

  it("save() writes via tmp + rename", async () => {
    const store = new OlmStore(storePath);
    // Place an existing file we expect to be replaced atomically.
    await writeFile(storePath, Buffer.from([7]));
    await store.save(new Uint8Array([8]));
    const onDisk = await readFile(storePath);
    expect(Array.from(onDisk)).toEqual([8]);
    // tmp file should not exist after a successful save.
    await expect(stat(storePath + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("save() failure mid-write leaves the original file intact", async () => {
    const store = new OlmStore(storePath);
    // Establish a known-good baseline.
    await store.save(new Uint8Array([0xaa, 0xbb, 0xcc]));
    const baseline = await readFile(storePath);

    // Simulate a crash mid-write by making the tmp path un-writable. The save
    // attempt must throw; the original file must still hold the baseline bytes.
    await chmod(dir, 0o500);
    await expect(store.save(new Uint8Array([0xff]))).rejects.toBeDefined();
    await chmod(dir, 0o700);

    const after = await readFile(storePath);
    expect(Array.from(after)).toEqual(Array.from(baseline));
  });

  it("save() creates parent directories that do not yet exist", async () => {
    const nested = path.join(dir, "a", "b", "c", "olm-store.pickle");
    const store = new OlmStore(nested);
    await store.save(new Uint8Array([1]));
    expect(await store.exists()).toBe(true);
    const loaded = await store.load();
    expect(Array.from(loaded!)).toEqual([1]);
  });
});
