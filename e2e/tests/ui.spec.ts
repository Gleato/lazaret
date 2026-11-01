import { expect, test } from "@playwright/test";

// The deployed Tidewater UI behind Lazaret, in a real browser, at desktop and phone
// width. Free: reads only. (gleator.com itself launches later, with the redesign.)

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Tidewater loads through Lazaret at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["x-lazaret-request-id"]).toBeTruthy();
    await expect(page).toHaveTitle(/Tidewater/i);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}

test("the Turnstile check page serves the production widget", async ({ page }) => {
  await page.goto("/demo/verify");
  await expect(page.locator("[data-sitekey]")).toHaveAttribute(
    "data-sitekey",
    "0x4AAAAAAFvvMgNi15gwPGyt",
  );
});

test("the public status and live stream answer", async ({ page, request }) => {
  const status = (await (await request.get("/__lazaret/status")).json()) as {
    budget: { capUsd: number };
  };
  expect(status.budget.capUsd).toBe(10);
  await page.goto("/");
  const hello = await page.evaluate(async () => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/__lazaret/live?after=0`);
    return await new Promise<string>((resolve, reject) => {
      ws.onmessage = (m) => {
        resolve((JSON.parse(String(m.data)) as { type: string }[])[0]?.type ?? "");
        ws.close();
      };
      ws.onerror = () => reject(new Error("socket error"));
      setTimeout(() => reject(new Error("no frame in 10 s")), 10_000);
    });
  });
  expect(hello).toBe("HELLO");
});
