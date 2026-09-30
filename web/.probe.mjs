import { chromium } from "playwright";
const b = await chromium.launch();
for (const [w,h,name] of [[1280,800,"desktop"],[390,844,"phone"]]) {
  const c = await b.newContext({ viewport:{width:w,height:h}, baseURL:"http://localhost:8178", hasTouch: w<500, isMobile: w<500 }); const p = await c.newPage();
  await p.goto("/"); await p.locator("#email").fill("admin@e2e.test"); await p.locator("#password").fill("e2e-admin-password-1"); await p.locator("form.lm-auth-form button[type=submit]").click();
  await p.getByRole("status", { name: /everything is saved/i }).first().waitFor(); await p.waitForTimeout(2000);
  await p.screenshot({ path: `${process.argv[2]}/icons-${name}.png`, clip: w < 500 ? { x: 0, y: 770, width: 390, height: 74 } : { x: 700, y: 0, width: 580, height: 52 } });
  await c.close();
}
await b.close();
