import { test, expect } from "@playwright/test";

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@verity.local";
const password = process.env.SEED_ADMIN_PASSWORD ?? "verity-dev-admin";

test("login failure then research verify workflow", async ({ page }) => {
  const stamp = Date.now();
  const collectionName = `E2E ${stamp}`;
  const sourceTitle = `France fact ${stamp}`;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password-value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByText("approved sources only")).toBeVisible();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  await page.getByRole("link", { name: "Knowledge" }).click();
  await page.getByLabel("Collection name").fill(collectionName);
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: collectionName }).click();
  await page.getByLabel("Title").fill(sourceTitle);
  await page.getByLabel(/File/).setInputFiles({
    name: "france.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("The capital of France is Paris."),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByRole("link", { name: sourceTitle }).click();
  await page.getByTestId("source-approve").click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByTestId("source-index").click();
  await expect(page.getByTestId("source-reindex")).toBeVisible();

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Research" }).click();
  await page.getByLabel("Question").fill("What is the capital of France?");
  await page.getByLabel("Knowledge mode").selectOption({ value: "grounded" });
  await page.getByRole("checkbox", { name: collectionName }).check();
  await page.getByRole("button", { name: "Run research" }).click();
  await expect(page.getByTestId("verity-record-link")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("verity-record-link").click();
  await expect(page.getByRole("heading", { name: "Verity Record" })).toBeVisible();
  await page.getByRole("button", { name: "Verify Record" }).click();
  await expect(page.getByText("Integrity Verified")).toBeVisible();
  await expect(page.getByText("Provenance Verified")).toBeVisible();
});
