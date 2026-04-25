import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (err, hash) => {
      if (err) reject(err);
      else resolve(`scrypt:${salt}:${hash.toString("hex")}`);
    });
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return Promise.resolve(false);
  const [, salt, hashHex] = parts;
  return new Promise((resolve) => {
    scrypt(password, salt!, 32, (err, derived) => {
      if (err) { resolve(false); return; }
      try {
        resolve(timingSafeEqual(derived, Buffer.from(hashHex!, "hex")));
      } catch { resolve(false); }
    });
  });
}
