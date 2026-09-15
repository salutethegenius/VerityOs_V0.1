import { test, expect } from "@playwright/test";

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@verity.local";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "verity-dev-admin";
const memberEmail = process.env.SEED_MEMBER_EMAIL ?? "member@verity.local";
const memberPassword = process.env.SEED_MEMBER_PASSWORD ?? "verity-dev-member";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

test("social draft approve publish and verify", async ({ page }) => {
  await signIn(page, memberEmail, memberPassword);

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Social Draft" }).click();
  await page.getByLabel("Brand").selectOption({ label: "Acme" });
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByRole("heading", { name: "Pending approval" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Log out" }).click();

  await signIn(page, adminEmail, adminPassword);
  await page.getByRole("link", { name: "Command" }).click();
  await page.getByRole("link", { name: "Approvals" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("button", { name: /nova.social.draft/ }).first().click();
  await expect(page.getByRole("button", { name: "Publish Now" })).toBeVisible();
  await page.getByRole("button", { name: "Publish Now" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Audit" }).click();
  await page.locator("table.data a").first().click();
  await expect(page.getByText("Approval evidence")).toBeVisible();
  await expect(page.getByText("Connector / action evidence")).toBeVisible();
  await page.getByRole("button", { name: "Verify Record" }).click();
  await expect(page.getByText("Integrity Verified")).toBeVisible();
});
