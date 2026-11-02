/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  MAX_CONDITION_LENGTH,
  MAX_TITLE_LENGTH,
  cleanCondition,
  cleanTitle,
  uniqueTitle,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/MonitorSetup.sys.mjs"
);

add_task(function test_cleanTitle() {
  Assert.equal(
    cleanTitle('  "Sony   WH-1000XM5\nprice."  '),
    "Sony WH-1000XM5 price",
    "Whitespace is collapsed and quotes and trailing punctuation dropped"
  );
  Assert.equal(cleanTitle(null), "", "A missing title is empty");
  Assert.equal(cleanTitle(42), "", "A title that is not a string is empty");

  const long =
    "Limited edition trail running shoes in every size the store carries";
  const cut = cleanTitle(long);
  Assert.lessOrEqual(cut.length, MAX_TITLE_LENGTH, "A long title is cut");
  Assert.ok(long.startsWith(cut), "A long title is cut from its end");
  Assert.strictEqual(
    long[cut.length],
    " ",
    "A long title is cut at a word boundary"
  );
  Assert.equal(
    cleanTitle("x".repeat(MAX_TITLE_LENGTH * 2)).length,
    MAX_TITLE_LENGTH,
    "A title without spaces is cut at the limit"
  );
});

add_task(function test_cleanCondition() {
  Assert.equal(
    cleanCondition("Notify me when the price drops below $50"),
    "The price drops below $50",
    "A condition repeating the form's label loses it"
  );
  Assert.equal(
    cleanCondition("let me know if  tickets go on sale"),
    "Tickets go on sale",
    "Other ways of asking to be told are dropped too"
  );
  Assert.equal(
    cleanCondition("“The Steam Frame is available to buy”"),
    "The Steam Frame is available to buy",
    "Wrapping quotes are dropped"
  );
  Assert.equal(
    cleanCondition("Notifications are turned on"),
    "Notifications are turned on",
    "Only a leading request to be told is dropped"
  );
  Assert.equal(cleanCondition(""), "", "An empty condition stays empty");
  Assert.equal(cleanCondition(undefined), "", "A missing condition is empty");
  Assert.equal(
    cleanCondition("a".repeat(MAX_CONDITION_LENGTH + 1)),
    "",
    "A condition too long for the form is dropped rather than cut"
  );
});

add_task(function test_uniqueTitle() {
  Assert.equal(uniqueTitle("Apple stock", []), "Apple stock");
  Assert.equal(
    uniqueTitle("Apple stock", ["apple STOCK"]),
    "Apple stock 2",
    "A name the user already has is numbered, ignoring case"
  );
  Assert.equal(
    uniqueTitle("Apple stock", ["Apple stock", "Apple stock 2"]),
    "Apple stock 3",
    "Numbering skips numbers already taken"
  );
  Assert.equal(uniqueTitle("", ["Apple stock"]), "", "Empty stays empty");
});
