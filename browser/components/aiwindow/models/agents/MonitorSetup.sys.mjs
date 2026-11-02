/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  MODEL_FEATURES,
  makeJSONSchemaBlob,
  parseAndExtractJSON,
  renderPrompt,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";
import {
  TOTAL_NUM_URLS_IN_MONITOR,
  isAllowedWatchUrl,
} from "moz-src:///browser/components/aiwindow/models/agents/Monitor.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
  loadPrompt:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  MonitorAgent:
    "moz-src:///browser/components/aiwindow/models/agents/MonitorAgent.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () =>
  console.createInstance({
    prefix: "MonitorSetup",
    maxLogLevelPref: "browser.smartwindow.monitorAgent.logLevel",
  })
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "suggestionsEnabled",
  "browser.smartwindow.agent.suggestions.enabled",
  true
);

export const MAX_TITLE_LENGTH = 50;
export const MAX_CONDITION_LENGTH = 200;
const MAX_CONDITION_PROMPT_LENGTH = 500;
const MAX_EXISTING_TITLES = 30;
const MAX_PAGE_TEXT_LENGTH = 8000;
const PAGE_TEXT_TIMEOUT_MS = 5 * 1000;
const SUGGESTION_TIMEOUT_MS = 20 * 1000;

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "condition"],
  properties: {
    title: { type: "string" },
    condition: { type: "string" },
  },
};

// The form already reads "Notify me when", so a condition that repeats it
// would read twice.
const NOTIFY_PREFIX_REGEX =
  /^(?:please\s+)?(?:notify|alert|tell|ping|let)\s+me\s+(?:know\s+)?(?:when|if|once|as soon as)\s+/i;

/**
 * @typedef {object} MonitorSetupSuggestion
 * @property {string} title - A name for the task, never one the user already
 *   has. Empty when none could be generated.
 * @property {string} condition - What to watch for, or "" when no condition was
 *   asked for or none could be generated.
 */

/**
 * Suggests what to fill a new monitor's form with: a task name grounded in the
 * pages and the user's condition and, while the user has not written one yet, a
 * condition to watch for grounded in what the pages say.
 */
export const MonitorSetup = {
  /**
   * @param {object} options
   * @param {string[]} [options.watchUrls] - Pages the monitor will watch
   * @param {Record<string, string>} [options.pageTitles] - Titles of those
   *   pages, keyed by URL
   * @param {string} [options.condition] - The condition the user wrote, if any
   * @param {boolean} [options.includeCondition] - Whether to suggest a
   *   condition too. Only honored when the user has not written one, and the
   *   suggestion is grounded in pages that are open in a tab.
   * @param {string[]} [options.existingTitles] - Names of the user's monitors,
   *   which the suggested name must not repeat
   * @returns {Promise<?MonitorSetupSuggestion>} null when suggestions are
   *   turned off or nothing usable came back
   */
  async suggest({
    watchUrls = [],
    pageTitles = {},
    condition = "",
    includeCondition = false,
    existingTitles = [],
  } = {}) {
    if (!lazy.suggestionsEnabled || lazy.MonitorAgent.isBlocked) {
      return null;
    }
    const urls = (Array.isArray(watchUrls) ? watchUrls : [])
      .filter(url => typeof url === "string" && isAllowedWatchUrl(url))
      .slice(0, TOTAL_NUM_URLS_IN_MONITOR);
    const userCondition = String(condition ?? "")
      .trim()
      .slice(0, MAX_CONDITION_PROMPT_LENGTH);
    if (!urls.length && !userCondition) {
      return null;
    }

    try {
      return await withTimeout(
        this._suggest({
          urls,
          pageTitles: pageTitles ?? {},
          userCondition,
          includeCondition: includeCondition && !userCondition,
          existingTitles: (Array.isArray(existingTitles) ? existingTitles : [])
            .map(title => String(title ?? "").trim())
            .filter(Boolean),
        }),
        SUGGESTION_TIMEOUT_MS
      );
    } catch (error) {
      lazy.log.warn(`No monitor setup suggestion: ${error.message ?? error}`);
      return null;
    }
  },

  async _suggest({
    urls,
    pageTitles,
    userCondition,
    includeCondition,
    existingTitles,
  }) {
    const conversation = await lazy.buildConversation(
      MODEL_FEATURES.AGENT_MONITOR_SETUP
    );
    const [{ prompt: systemTemplate }, { prompt: userTemplate }] =
      await Promise.all([
        lazy.loadPrompt(MODEL_FEATURES.AGENT_MONITOR_SETUP, {
          module: "system-instructions",
        }),
        lazy.loadPrompt(MODEL_FEATURES.AGENT_MONITOR_SETUP, {
          module: "user-data",
        }),
      ]);

    const pageText = includeCondition
      ? await this._extractOpenPageText(urls, conversation)
      : "";

    conversation.setSystemMessage(
      renderPrompt(systemTemplate, {
        locale: Services.locale.appLocaleAsBCP47,
      })
    );
    // Page text goes last so nothing it contains is read as a placeholder.
    conversation.addUserMessage(
      renderPrompt(userTemplate, {
        pages: urls
          .map(url => {
            const title = pageTitles[url];
            return title
              ? `- ${sanitizeUntrustedContent(title)} (${url})`
              : `- ${url}`;
          })
          .join("\n"),
        condition: userCondition,
        suggestCondition: includeCondition ? "true" : "",
        existingTitles: existingTitles
          .slice(0, MAX_EXISTING_TITLES)
          .map(title => `- ${title}`)
          .join("\n"),
        pageText,
      })
    );

    const response = await conversation.run({
      token: await AuthProvider.getToken(),
      inferenceParams: {
        response_format: makeJSONSchemaBlob(
          "MonitorSetupSuggestion",
          SUGGESTION_SCHEMA
        ),
      },
      tools: [],
    });

    const parsed = parseAndExtractJSON(response, null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The model did not return a suggestion.");
    }
    const title = uniqueTitle(cleanTitle(parsed.title), existingTitles);
    const suggestedCondition = includeCondition
      ? cleanCondition(parsed.condition)
      : "";
    if (!title && !suggestedCondition) {
      throw new Error("The model returned an empty suggestion.");
    }
    return { title, condition: suggestedCondition };
  },

  /**
   * Reads the pages that are open in a tab. Pages that would need a fresh
   * load are left out: the suggestion has to arrive while the form is open.
   *
   * @param {string[]} urls
   * @param {object} conversation
   * @returns {Promise<string>} The text of the pages that could be read, or ""
   */
  async _extractOpenPageText(urls, conversation) {
    const openUrls = urls.filter(url => lazy.GetPageContent.getTabWithURL(url));
    if (!openUrls.length) {
      return "";
    }
    const abortController = new AbortController();
    const timer = lazy.setTimeout(
      () => abortController.abort(new Error("Reading the pages timed out.")),
      PAGE_TEXT_TIMEOUT_MS
    );
    try {
      const results = await lazy.GetPageContent.getPageContent(
        { url_list: openUrls, signal: abortController.signal },
        conversation
      );
      return results
        .filter(result => result.ok)
        .map(result => result.content)
        .join("\n\n<----- PAGE BREAK ---->\n\n")
        .slice(0, MAX_PAGE_TEXT_LENGTH);
    } catch (error) {
      lazy.log.warn(`Could not read the pages: ${error.message ?? error}`);
      return "";
    } finally {
      lazy.clearTimeout(timer);
    }
  },
};

/**
 * @param {*} value - The model's title
 * @returns {string} A single line without wrapping quotes or trailing
 *   punctuation, cut at a word boundary to fit MAX_TITLE_LENGTH.
 */
export function cleanTitle(value) {
  let title = collapseWhitespace(value)
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[.!?;:,\s]+$/, "");
  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH + 1);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).slice(
      0,
      MAX_TITLE_LENGTH
    );
    title = title.replace(/[.!?;:,\-\s]+$/, "");
  }
  return title;
}

/**
 * @param {*} value - The model's condition
 * @returns {string} A single line that completes "Notify me when", or "" when
 *   it would not fit MAX_CONDITION_LENGTH.
 */
export function cleanCondition(value) {
  const condition = collapseWhitespace(value)
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(NOTIFY_PREFIX_REGEX, "");
  if (!condition || condition.length > MAX_CONDITION_LENGTH) {
    return "";
  }
  return condition[0].toLocaleUpperCase() + condition.slice(1);
}

/**
 * @param {string} title
 * @param {string[]} existingTitles
 * @returns {string} The title, numbered when the user already has a monitor by
 *   that name.
 */
export function uniqueTitle(title, existingTitles) {
  if (!title) {
    return "";
  }
  const taken = new Set(existingTitles.map(t => t.toLocaleLowerCase()));
  if (!taken.has(title.toLocaleLowerCase())) {
    return title;
  }
  for (let n = 2; ; n++) {
    const candidate = `${title} ${n}`;
    if (!taken.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
}

function collapseWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = lazy.setTimeout(
      () => reject(new Error("The suggestion timed out.")),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    lazy.clearTimeout(timer);
  }
}
