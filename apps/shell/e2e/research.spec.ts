import { test, expect } from "@playwright/test";

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@verity.local";
const password = process.env.SEED_ADMIN_PASSWORD ?? "verity-dev-admin";

test("login failure then research verify workflow", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password-value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(/invalid|credential|password/i);

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByText("approved sources only")).toBeVisible();

  await page.getByRole("link", { name: "Knowledge" }).click();
  await page.getByLabel("Collection name").fill(`E2E ${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link").filter({ hasText: "E2E" }).first().click();
  await page.getByLabel("Title").fill("France fact");
  await page.getByLabel(/File/).setInputFiles({
    name: "france.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("The capital of France is Paris."),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByRole("link", { name: "France fact" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved")).toBeVisible();
  await page.getByRole("button", { name: "Index" }).click();

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Research" }).click();
  await page.getByLabel("Question").fill("What is the capital of France?");
  await page.getByLabel("Knowledge mode").selectOption("grounded");
  const collectionBox = page.getByRole("checkbox").first();
  if (await collectionBox.count()) {
    await collectionBox.check();
  }
  await page.getByRole("button", { name: "Run research" }).click();
  await expect(page.getByText(/completed|blocked|Insufficient/i)).toBeVisible({ timeout: 60_000 });

  const recordLink = page.getByRole("link").filter({ hasText: /[0-9a-f-]{8}/ }).first();
  await recordLink.click();
  await expect(page.getByRole("heading", { name: "Verity Record" })).toBeVisible();
  await page.getByRole("button", { name: "Verify Record" }).click();
  await expect(page.getByText("Integrity Verified")).toBeVisible();
  await expect(page.getByText("Provenance Verified")).toBeVisible();
});
