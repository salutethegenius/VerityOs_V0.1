import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords.js";

describe("password hashing", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("other-password-xx", hash)).toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/10 characters/);
  });
});
