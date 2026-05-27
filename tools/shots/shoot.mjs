import puppeteer from "puppeteer-core";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import * as D from "./data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = pathToFileURL(path.join(here, "harness.html")).href;
const outDir = path.resolve(here, "../../media");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const feed = async (page, msgs) => {
  for (const m of msgs) await page.evaluate((msg) => window.__ctFeed(msg), m);
};

const newPage = async (browser, { width, height }) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto(harness, { waitUntil: "load" });
  await sleep(250);
  return page;
};

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--force-color-profile=srgb", "--hide-scrollbars"],
  });

  // 1. Multi-session terminal cockpit (the home view)
  {
    const page = await newPage(browser, { width: 1600, height: 1000 });
    await feed(page, [D.update]);
    await sleep(200);
    await feed(page, [
      { type: "cockpitLayout", layout: { trees: { __all__: {
        kind: "split", dir: "row", sizes: [1, 1],
        children: [
          { kind: "split", dir: "col", sizes: [1, 1], children: [{ kind: "leaf", id: "t1" }, { kind: "leaf", id: "t3" }] },
          { kind: "split", dir: "col", sizes: [1, 1], children: [{ kind: "leaf", id: "t2" }, { kind: "leaf", id: "t4" }] },
        ],
      } } } },
      D.cockpitState,
    ]);
    await sleep(400);
    await feed(page, D.terminalData);
    await sleep(600);
    await feed(page, [{ type: "terminalAttention", sessionId: "t4", reason: "notify" }]);
    await sleep(500);
    await page.screenshot({ path: path.join(outDir, "shot-cockpit.png") });
    await page.close();
    console.log("✓ shot-cockpit.png");
  }

  // 2. Cost + observability dashboard (session detail)
  {
    const page = await newPage(browser, { width: 1600, height: 1000 });
    await feed(page, [D.update]);
    await sleep(300);
    await page.click(".session-item");
    await sleep(150);
    await feed(page, [D.detail]);
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, "shot-dashboard.png") });
    console.log("✓ shot-dashboard.png");

    // 3. Customize panel open over the detail
    const clicked = await page.evaluate(() => {
      const b = document.querySelector(".detail-customize-btn");
      if (b) { b.click(); return true; }
      return false;
    });
    await sleep(500);
    if (clicked) {
      await page.screenshot({ path: path.join(outDir, "shot-customize.png") });
      console.log("✓ shot-customize.png");
    } else {
      console.log("! customize button not found");
    }
    await page.close();
  }

  // 4. Workflows / pipelines orchestrator
  {
    const page = await newPage(browser, { width: 1600, height: 1000 });
    await feed(page, [D.update]);
    await sleep(200);
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll(".ct-tab")).find((t) => /workflow/i.test(t.textContent || ""));
      tab?.click();
    });
    await sleep(200);
    await feed(page, [D.pipelinesList, D.pipelineDetail ?? { type: "pipelineDetail", pipeline: D.pipelinesList.payload.pipelines[0] }, D.runUpdate]);
    await sleep(400);
    await page.evaluate(() => {
      const run = document.querySelector("[data-run-id], .pl-run-item, .pl-run-row");
      if (run && run instanceof HTMLElement) run.click();
    });
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, "shot-workflows.png") });
    await page.close();
    console.log("✓ shot-workflows.png");
  }

  await browser.close();
};

run().catch((e) => { console.error(e); process.exit(1); });
