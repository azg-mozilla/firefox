/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Answers agent-monitor-item requests that need privileged data, in any page
 * that hosts the card. The answer is dispatched back on the card that asked,
 * so the hosting page doesn't take part.
 */
export class AgentMonitorItemChild extends JSWindowActorChild {
  /**
   * @param {CustomEvent} event
   */
  async handleEvent(event) {
    switch (event.type) {
      case "agent-monitor-item:resolve-titles":
        await this.#resolveTitles(event);
        break;
      case "agent-monitor-item:request-suggestion":
        await this.#requestSuggestion(event);
        break;
    }
  }

  /**
   * @param {CustomEvent} event
   */
  async #resolveTitles(event) {
    // event.target is retargeted to the page's outermost shadow host, so take the
    // card from the path, which is only available while the event is dispatching
    const card = event.composedPath()[0];
    const urls = Array.from(event.detail?.urls ?? []);
    if (!card || !urls.length) {
      return;
    }

    try {
      const titles = await this.sendQuery("AgentMonitorItem:ResolveTitles", {
        urls,
      });
      card.dispatchEvent(
        new this.contentWindow.CustomEvent(
          "agent-monitor-item:titles-resolved",
          { detail: Cu.cloneInto({ titles }, this.contentWindow) }
        )
      );
    } catch (error) {
      console.warn("AgentMonitorItemChild: could not resolve titles", error);
    }
  }

  /**
   * @param {CustomEvent} event
   */
  async #requestSuggestion(event) {
    const card = event.composedPath()[0];
    const { requestId, watchUrls, condition, includeCondition } =
      event.detail ?? {};
    if (!card) {
      return;
    }

    try {
      const suggestion = await this.sendQuery("AgentMonitorItem:Suggest", {
        watchUrls: Array.from(watchUrls ?? []),
        condition: String(condition ?? ""),
        includeCondition: !!includeCondition,
      });
      if (!suggestion) {
        return;
      }
      card.dispatchEvent(
        new this.contentWindow.CustomEvent("agent-monitor-item:suggestion", {
          detail: Cu.cloneInto(
            { requestId, ...suggestion },
            this.contentWindow
          ),
        })
      );
    } catch (error) {
      console.warn("AgentMonitorItemChild: could not get a suggestion", error);
    }
  }
}
