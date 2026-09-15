import { test, expect } from "@playwright/test";

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@verity.local";
const password = process.env.SEED_ADMIN_PASSWORD ?? "verity-dev-admin";

test("social draft approve publish and verify", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Social Draft" }).click();
  await page.getByLabel("Brand").selectOption({ label: "Acme" });
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByText("Pending approval")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("button", { name: "Publish Now" })).toBeVisible();
  await page.getByRole("button", { name: "Publish Now" }).click();
  await expect(page.getByText("Published")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Audit" }).click();
  await page.getByRole("link").filter({ hasText: /[0-9a-f-]{8,}/ }).first().click();
  await expect(page.getByText("Approval evidence")).toBeVisible();
  await expect(page.getByText("Connector / action evidence")).toBeVisible();
  await page.getByRole("button", { name: "Verify Record" }).click();
  await expect(page.getByText("Integrity Verified")).toBeVisible();
});
