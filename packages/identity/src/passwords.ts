import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const keyLen = 32;

function scrypt(password: string, salt: Buffer, length: number, n: number, nr: number, np: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, length, { N: n, r: nr, p: np }, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("password must be at least 10 characters");
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, keyLen, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const nr = Number(parts[2]);
  const np = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  const actual = await scrypt(password, salt, expected.length, n, nr, np);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export async function hashSecret(secret: string): Promise<string> {
  return hashPassword(secret.length >= 10 ? secret : `${secret}________`);
}
