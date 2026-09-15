import { test, expect } from "@playwright/test";

const officerEmail = process.env.DEMO_OFFICER_EMAIL ?? "communications@verity-demo.local";
const officerPassword = process.env.DEMO_OFFICER_PASSWORD ?? "verity-demo-officer";
const directorEmail = process.env.DEMO_DIRECTOR_EMAIL ?? "director@verity-demo.local";
const directorPassword = process.env.DEMO_DIRECTOR_PASSWORD ?? "verity-demo-director";
const analystEmail = process.env.DEMO_ANALYST_EMAIL ?? "analyst@verity-demo.local";
const analystPassword = process.env.DEMO_ANALYST_PASSWORD ?? "verity-demo-analyst";

const STORM_PROMPT =
  "Using approved institutional guidance only, prepare a public advisory telling residents what actions to take and what information should not yet be published.";

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

test("government communications draft approve publish verify", async ({ page }) => {
  await signIn(page, officerEmail, officerPassword);

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Social Draft" }).click();
  await page.getByLabel("Brand").selectOption({ label: "Demo Civil Protection" });
  await page.getByLabel("Topic (optional)").fill(STORM_PROMPT);
  await page.getByRole("checkbox", { name: "Institutional Guidance (Synthetic Demo)" }).check();
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByRole("heading", { name: "Pending approval" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("nova-citations")).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();

  await signIn(page, directorEmail, directorPassword);
  await page.getByRole("link", { name: "Command" }).click();
  await page.getByRole("link", { name: "Approvals" }).click();
  const approve = page.getByTestId("approval-decide-allow").first();
  await expect(approve).toBeVisible();
  const decided = page.waitForResponse(
    (response) => response.url().includes("/decide") && response.request().method() === "POST"
  );
  await approve.click();
  expect((await decided).ok()).toBeTruthy();

  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Social Draft" }).click();
  await page.getByRole("button", { name: /Social Draft|nova.social.draft/ }).first().click();
  await expect(page.getByTestId("nova-citations")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish Now" })).toBeVisible();
  const published = page.waitForResponse(
    (response) => response.url().includes("/connectors/actions") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Publish Now" }).click();
  expect((await published).ok()).toBeTruthy();
  await expect(page.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Audit" }).click();
  await page.locator("table.data a").first().click();
  await expect(page.getByText("Approval evidence")).toBeVisible();
  await expect(page.getByText("Connector / action evidence")).toBeVisible();
  await page.getByRole("button", { name: "Verify Record" }).click();
  await expect(page.getByText("Integrity Verified")).toBeVisible();
  await expect(page.getByText("Provenance Verified")).toBeVisible();
});

test("strict unsupported question shows insufficient approved evidence", async ({ page }) => {
  await signIn(page, officerEmail, officerPassword);
  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Research" }).click();
  await page.getByLabel("Question").fill(
    "What is the classified satellite frequency for Operation Meridian in this office?"
  );
  await page.getByLabel("Knowledge mode").selectOption({ value: "strict" });
  await page.getByRole("checkbox", { name: "Institutional Guidance (Synthetic Demo)" }).check();
  await page.getByRole("button", { name: "Run research" }).click();
  await expect(page.getByTestId("insufficient-evidence")).toBeVisible({ timeout: 60_000 });
});

test("analyst cannot invoke social draft or connector publish", async ({ page }) => {
  await signIn(page, analystEmail, analystPassword);
  await page.getByRole("link", { name: "Nova" }).click();
  await page.getByRole("tab", { name: "Social Draft" }).click();
  await page.getByLabel("Brand").selectOption({ label: "Demo Civil Protection" });
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByText("missing permission social.draft")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Publish Now" })).toHaveCount(0);
});
