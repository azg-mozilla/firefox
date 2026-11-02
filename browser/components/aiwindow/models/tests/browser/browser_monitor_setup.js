/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @type {import("../../../ui/test/AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { MonitorSetup } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/MonitorSetup.sys.mjs"
);

const { PURPOSES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);

const PRODUCT_TITLE = "Trail Runner 2 shoes";
const PRODUCT_PAGE = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${PRODUCT_TITLE}</title>
    </head>
    <body>
      <h1>${PRODUCT_TITLE}</h1>
      <p>Price: $129.99</p>
      <p>In stock, ships in 2 days</p>
    </body>
  </html>
`;

/**
 * Serves the product page and opens it in a tab of this window, marked as a
 * Smart Window so its content can be read without a fresh load.
 *
 * @param {Function} task - Called with the page's URL
 */
async function withOpenProductPage(task) {
  const mockEngineManager = new MockEngineManager();
  const { url, server } = serveHTML(PRODUCT_PAGE);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url, true);
  window.document.documentElement.setAttribute("ai-window", "true");
  try {
    await task({ url, mockEngineManager });
  } finally {
    window.document.documentElement.removeAttribute("ai-window");
    BrowserTestUtils.removeTab(tab);
    await mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await new Promise(resolve => server.stop(resolve));
  }
}

add_task(async function test_suggests_title_and_condition_from_open_page() {
  await withOpenProductPage(async ({ url, mockEngineManager }) => {
    const suggestion = MonitorSetup.suggest({
      watchUrls: [url],
      pageTitles: { [url]: PRODUCT_TITLE },
      includeCondition: true,
      existingTitles: ["Portland weather"],
    });

    const { request, respond } = await mockEngineManager.captureRequest({
      purpose: PURPOSES.MONITOR,
    });
    const sent = JSON.stringify(request.args);
    Assert.deepEqual(request.tools, [], "The request offers no tools");
    Assert.ok(
      sent.includes("$129.99"),
      "The text of the open page grounds the condition"
    );
    Assert.ok(sent.includes(url), "The request names the page to watch");
    Assert.ok(sent.includes(PRODUCT_TITLE), "and its title");
    Assert.ok(
      sent.includes("- Portland weather"),
      "The user's existing task names are listed so they are not repeated"
    );
    Assert.ok(
      sent.includes("has not written a condition yet"),
      "The request asks for a condition"
    );

    respond(
      JSON.stringify({
        title: "Trail Runner 2 price.",
        condition: "Notify me when the price drops below $129.99",
      })
    );
    Assert.deepEqual(
      await suggestion,
      {
        title: "Trail Runner 2 price",
        condition: "The price drops below $129.99",
      },
      "The suggestion is cleaned up for the form"
    );
  });
});

add_task(async function test_title_only_when_the_user_wrote_a_condition() {
  await withOpenProductPage(async ({ url, mockEngineManager }) => {
    const suggestion = MonitorSetup.suggest({
      watchUrls: [url],
      pageTitles: { [url]: PRODUCT_TITLE },
      condition: "it is back in stock in size 10",
      includeCondition: true,
    });

    const { request, respond } = await mockEngineManager.captureRequest({
      purpose: PURPOSES.MONITOR,
    });
    const sent = JSON.stringify(request.args);
    Assert.ok(
      sent.includes("it is back in stock in size 10"),
      "The user's condition grounds the name"
    );
    Assert.ok(
      !sent.includes("$129.99"),
      "The page is not read when only a name is needed"
    );
    Assert.ok(
      !sent.includes("has not written a condition yet"),
      "No condition is asked for over the user's own"
    );

    respond(
      JSON.stringify({
        title: "Trail Runner 2 size 10 restock",
        condition: "Something else entirely",
      })
    );
    Assert.deepEqual(
      await suggestion,
      { title: "Trail Runner 2 size 10 restock", condition: "" },
      "Only the name is suggested"
    );
  });
});

add_task(async function test_title_never_repeats_an_existing_name() {
  await withOpenProductPage(async ({ url, mockEngineManager }) => {
    const suggestion = MonitorSetup.suggest({
      watchUrls: [url],
      condition: "the price drops",
      existingTitles: ["Trail Runner 2 price", "trail runner 2 price 2"],
    });
    await mockEngineManager.respondTo({
      purpose: PURPOSES.MONITOR,
      response: JSON.stringify({
        title: "Trail Runner 2 price",
        condition: "",
      }),
    });
    Assert.deepEqual(
      await suggestion,
      { title: "Trail Runner 2 price 3", condition: "" },
      "A name the user already has is numbered"
    );
  });
});

add_task(async function test_unusable_answers_suggest_nothing() {
  await withOpenProductPage(async ({ url, mockEngineManager }) => {
    for (const response of [
      "not json",
      JSON.stringify({ title: "", condition: "" }),
      JSON.stringify(["Trail Runner 2 price"]),
    ]) {
      const suggestion = MonitorSetup.suggest({
        watchUrls: [url],
        includeCondition: true,
      });
      await mockEngineManager.respondTo({
        purpose: PURPOSES.MONITOR,
        response,
      });
      Assert.strictEqual(
        await suggestion,
        null,
        `An unusable answer suggests nothing: ${response}`
      );
    }

    const suggestion = MonitorSetup.suggest({
      watchUrls: [url],
      condition: "the price drops",
    });
    const { reject } = await mockEngineManager.captureRequest({
      purpose: PURPOSES.MONITOR,
    });
    reject(new Error("429 status code (no body)"));
    Assert.strictEqual(
      await suggestion,
      null,
      "A failed model call suggests nothing rather than throwing"
    );
  });
});

add_task(async function test_nothing_to_ground_or_turned_off() {
  await withOpenProductPage(async ({ url, mockEngineManager }) => {
    Assert.strictEqual(
      await MonitorSetup.suggest({ watchUrls: ["about:blank"] }),
      null,
      "Pages a monitor can't watch give nothing to ground a suggestion in"
    );

    await SpecialPowers.pushPrefEnv({
      set: [["browser.smartwindow.agent.suggestions.enabled", false]],
    });
    try {
      Assert.strictEqual(
        await MonitorSetup.suggest({
          watchUrls: [url],
          includeCondition: true,
        }),
        null,
        "Suggestions can be turned off"
      );
    } finally {
      await SpecialPowers.popPrefEnv();
    }

    Assert.equal(
      mockEngineManager.engines.get(PURPOSES.MONITOR)?.runRequests.size ?? 0,
      0,
      "No model call was made"
    );
  });
});
