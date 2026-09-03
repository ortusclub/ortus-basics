const {
  sendToSheet,
  getServiceAccountEmail,
  isPermissionError,
} = require("./sheets");
const { EventEmitter } = require("events");

// Set the Sales Navigator search URL's `page=N` param without disturbing the
// rest of the query (its `query=(...)` value is fragile — re-encoding via the
// URL API can break the search), so we splice the page token by string.
//   • already has page=<n>  → replace it
//   • has a query but no page → append &page=N
//   • no query at all         → append ?page=N
function withPage(url, n) {
  if (/[?&]page=\d+/.test(url)) return url.replace(/([?&]page=)\d+/, `$1${n}`);
  return url + (url.includes("?") ? "&" : "?") + "page=" + n;
}

// Set the `start` paging offset in a Sales Nav search API URL or GraphQL body.
// Handles query-string (start=0), GraphQL variable JSON ("start":0), and bare
// variable (start:0) forms. If there's no explicit start we append one to the
// query string as a best-effort.
function bumpStart(str, offset) {
  if (/[?&]start=\d+/.test(str)) return str.replace(/([?&]start=)\d+/, `$1${offset}`);
  if (/"start":\s*\d+/.test(str)) return str.replace(/("start":\s*)\d+/, `$1${offset}`);
  if (/\bstart:\s*\d+/.test(str)) return str.replace(/(\bstart:\s*)\d+/, `$1${offset}`);
  return str.includes("?") ? str + "&start=" + offset : str;
}

const SEARCH_PAGE_SIZE = 25; // Sales Nav search returns 25 results/page

class Scraper extends EventEmitter {
  constructor(options = {}) {
    super();
    this.slowMode = options.slowMode || process.env.SLOW_MODE === "true";
    this.userId = options.userId || "default";
    // GoLogin profile that drives this scrape (carries the LinkedIn session).
    // Falls back to userId for back-compat with older callers.
    this.profileId = options.profileId || options.userId || "default";
    this.page = null;
    this.stopped = false;
    this.paused = false;
    this.totalProfiles = 0;
    this.totalPages = 0;
    // Profiles captured from API responses via network interception
    this.interceptedProfiles = [];
    // Rate limit flag set by network interceptor
    this.rateLimited = false;
    this.rateLimitLogged = false;
    this.forbiddenLogged = false;
    // Tracks every memberUrn written to the sheet this scrape so we don't
    // write the same lead twice when LinkedIn's pagination click silently
    // fails to navigate (it sometimes returns the same DOM/API payload
    // multiple "pages" in a row).
    this.writtenUrns = new Set();
    // Consecutive pages that yielded zero NEW profiles — used to bail out
    // of a stuck pagination loop instead of looping up to maxPages.
    this.consecutiveDupePages = 0;
  }

  // ─── Timing ───────────────────────────────────────────────────
  async delay() {
    const min = this.slowMode ? 6000 : 2000;
    const max = this.slowMode ? 10000 : 4000;
    const ms = Math.floor(Math.random() * (max - min) + min);
    this.emit("log", `Waiting ${(ms / 1000).toFixed(1)}s…`);
    await new Promise((r) => setTimeout(r, ms));
  }

  async waitWhilePaused() {
    while (this.paused && !this.stopped) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  stop() {
    this.stopped = true;
    if (this.page) {
      this.page.close().catch(() => {});
      this.page = null;
    }
    this.emit("log", "Scraper stopped by user");
  }

  pause() {
    this.paused = true;
    this.emit("log", "Scraper paused");
  }

  resume() {
    this.paused = false;
    this.emit("log", "Scraper resumed");
  }

  /**
   * Start a CDP screencast of this job's page — the live engine behind the
   * per-job "View" feature. Chrome pushes a JPEG frame each time the page
   * repaints (several fps); we hand each frame buffer to `onFrame`. Returns an
   * async stop() that tears the screencast + CDP session down. Best-effort:
   * resolves to a no-op stop if the page is gone or CDP refuses.
   */
  async startScreencast(onFrame, { quality = 50, maxWidth = 1280, maxHeight = 800 } = {}) {
    const noop = async () => {};
    if (!this.page) return noop;

    let client;
    try {
      client = await this.page.context().newCDPSession(this.page);
    } catch (_) {
      return noop;
    }

    const onFrameEvt = async ({ data, sessionId }) => {
      try { onFrame(Buffer.from(data, "base64")); } catch (_) {}
      // Must ack or Chrome stops sending frames.
      try { await client.send("Page.screencastFrameAck", { sessionId }); } catch (_) {}
    };
    client.on("Page.screencastFrame", onFrameEvt);

    try {
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame: 1,
      });
    } catch (_) {
      try { client.off("Page.screencastFrame", onFrameEvt); } catch (_) {}
      try { await client.detach(); } catch (_) {}
      return noop;
    }

    return async () => {
      try { client.off("Page.screencastFrame", onFrameEvt); } catch (_) {}
      try { await client.send("Page.stopScreencast"); } catch (_) {}
      try { await client.detach(); } catch (_) {}
    };
  }

  // ─── Network Interception ─────────────────────────────────────
  /**
   * Set up Playwright response listeners to capture Sales Nav API data.
   * This replaces the broken addInitScript interceptor.
   */
  setupNetworkInterception(page) {
    this.interceptedProfiles = [];

    page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      // Detect LinkedIn rate limiting (429 Too Many Requests)
      if (status === 429) {
        if (!this.rateLimitLogged) {
          this.emit("log", "🚫  LinkedIn returned 429 Too Many Requests — you are being rate limited. Slow down or wait before scraping more.");
          this.rateLimitLogged = true;
        }
        this.rateLimited = true;
        return;
      }

      // Match Sales Navigator search API endpoints
      if (
        !url.includes("/voyager/api/") &&
        !url.includes("/sales-api/") &&
        !url.includes("/salesApi")
      ) {
        return;
      }

      // Only intercept search-related responses
      if (
        !url.includes("Search") &&
        !url.includes("search") &&
        !url.includes("leadSearch") &&
        !url.includes("blended")
      ) {
        return;
      }

      try {
        const json = await response.json();
        const profiles = this.parseApiResponse(json);
        if (profiles.length > 0) {
          // Capture the search API request ONCE so pagination can replay it with
          // paging offsets (direct-API pagination). This is format-agnostic —
          // works for #query= fragment URLs where UI navigation can't advance.
          if (!this._searchApi) {
            try {
              const req = response.request();
              this._searchApi = {
                url: response.url(),
                method: req.method(),
                headers: req.headers(),
                postData: req.postData() || null,
              };
              this.emit(
                "log",
                `  → captured search API (${req.method()} …/${response.url().split("?")[0].split("/").pop()}, body=${req.postData() ? "yes" : "no"})`
              );
            } catch (_) {
              /* request unavailable — direct-API paging just won't engage */
            }
          }
          this.interceptedProfiles.push(...profiles);
          this.emit("log", `  → API intercepted ${profiles.length} profiles`);
        }
      } catch (e) {
        // Not JSON or parsing failed — skip
      }
    });
  }

  /**
   * Parse a Sales Navigator API response and extract profile data.
   */
  parseApiResponse(json) {
    const profiles = [];

    // The response structure varies — try multiple paths
    const containers = [
      json?.data?.searchDashClustersByAll?.elements,
      json?.data?.searchDashLeadsByAll?.elements,
      json?.elements,
      json?.data?.elements,
      json?.included,
    ].filter(Boolean);

    for (const elements of containers) {
      for (const el of elements) {
        // Each element might be a cluster with items, or a direct result
        const items = el?.items || el?.elements || [el];
        for (const item of items) {
          const profile = this.extractFromApiItem(item);
          if (profile) profiles.push(profile);
        }
      }
    }

    // Also try the `included` array which LinkedIn uses for entity data
    if (json?.included) {
      for (const entity of json.included) {
        if (
          entity?.$type?.includes("salesProfile") ||
          entity?.$type?.includes("MiniProfile")
        ) {
          const profile = this.extractFromIncludedEntity(entity);
          if (profile) profiles.push(profile);
        }
      }
    }

    // Deduplicate by memberUrn
    const seen = new Set();
    return profiles.filter((p) => {
      if (!p.memberUrn || seen.has(p.memberUrn)) return false;
      seen.add(p.memberUrn);
      return true;
    });
  }

  extractFromApiItem(item) {
    try {
      const entity =
        item?.entityResult || item?.item?.entityResult || item?.entity || item;
      if (!entity) return null;

      // Get name
      const fullName =
        entity?.title?.text || entity?.fullName || entity?.title || "";
      if (!fullName || typeof fullName !== "string") return null;

      // Get member URN
      let memberUrn = "";
      const urn =
        entity?.entityUrn || entity?.objectUrn || entity?.trackingUrn || "";
      if (urn.includes("salesProfile:")) {
        memberUrn =
          urn.split("salesProfile:")[1]?.split(",")[0]?.replace(/[()]/g, "") ||
          "";
      } else if (urn.includes("member:")) {
        memberUrn =
          urn.split("member:")[1]?.split(",")[0]?.replace(/[()]/g, "") || "";
      }

      // Get profile URL
      let profileUrl = entity?.navigationUrl || "";
      if (profileUrl) {
        try {
          profileUrl = new URL(profileUrl, "https://www.linkedin.com").pathname;
        } catch (e) {}
      }

      // Try to extract memberUrn from URL if not found yet
      if (!memberUrn && profileUrl) {
        const m = profileUrl.match(/\/lead\/([^,/?]+)/);
        if (m) memberUrn = m[1];
      }

      if (!memberUrn) return null;

      // Name parts
      const firstName = entity?.firstName || "";
      const lastName = entity?.lastName || "";

      // Title and company
      const title =
        entity?.primarySubtitle?.text ||
        entity?.currentPositions?.[0]?.title ||
        "";
      const company =
        entity?.secondarySubtitle?.text ||
        entity?.currentPositions?.[0]?.companyName ||
        "";
      const location = entity?.summary?.text || entity?.geoRegion || "";

      // Badges — LinkedIn moves these around between response shapes, so
      // we check every place we've ever seen them.
      const badges = [
        ...(entity?.badgeData?.badges || []),
        ...(entity?.badges || []),
        ...(entity?.memberBadges || []),
      ];
      const badgeMatches = (test) =>
        badges.some((b) => {
          if (!b) return false;
          const blob = JSON.stringify(b).toLowerCase();
          return test(blob, b);
        });

      const isOpenLink =
        entity?.openLink === true ||
        entity?.openProfile === true ||
        badgeMatches(
          (blob, b) =>
            b?.type === "OPEN_LINK" ||
            blob.includes("openlink") ||
            blob.includes("open_link") ||
            (typeof b?.text === "string" && b.text.toLowerCase().includes("open"))
        );

      const isPremium =
        entity?.premium === true ||
        entity?.isPremium === true ||
        entity?.premiumSubscriber === true ||
        entity?.degree === "PREMIUM" ||
        badgeMatches(
          (blob, b) =>
            b?.type === "PREMIUM" ||
            blob.includes("premium") ||
            blob.includes("inbug-gold") ||
            (typeof b?.text === "string" &&
              b.text.toLowerCase().includes("premium"))
        );

      return {
        fullName: fullName.trim(),
        firstName: firstName || fullName.split(/\s+/)[0] || "",
        lastName: lastName || fullName.split(/\s+/).slice(1).join(" ") || "",
        title: title.trim(),
        company: company.trim(),
        location: location.trim(),
        profileUrl,
        memberUrn,
        isOpenLink,
        isPremium,
        source: "api",
      };
    } catch (e) {
      return null;
    }
  }

  extractFromIncludedEntity(entity) {
    try {
      const firstName = entity?.firstName || "";
      const lastName = entity?.lastName || "";
      const fullName = `${firstName} ${lastName}`.trim();
      if (!fullName) return null;

      let memberUrn = "";
      const urn = entity?.entityUrn || entity?.objectUrn || "";
      if (urn.includes("salesProfile:")) {
        memberUrn =
          urn.split("salesProfile:")[1]?.split(",")[0]?.replace(/[()]/g, "") ||
          "";
      } else if (urn.includes("miniProfile:")) {
        memberUrn =
          urn.split("miniProfile:")[1]?.split(",")[0]?.replace(/[()]/g, "") ||
          "";
      }
      if (!memberUrn) return null;

      const title = entity?.occupation || entity?.headline || "";
      const location = entity?.geoRegion || entity?.locationName || "";

      // Premium can show up as several flags on the included entity
      const isPremium =
        entity?.premium === true ||
        entity?.isPremium === true ||
        entity?.premiumSubscriber === true ||
        entity?.subscriber === true;

      return {
        fullName,
        firstName,
        lastName,
        title: title.trim(),
        company: "",
        location: location.trim(),
        profileUrl: "",
        memberUrn,
        isOpenLink: entity?.openLink === true || false,
        isPremium,
        source: "api",
      };
    } catch (e) {
      return null;
    }
  }

  // ─── DOM Extraction ───────────────────────────────────────────
  /**
   * Flush intercepted profiles and return them, then also scrape the DOM.
   */
  async extractProfiles(page) {
    // 1. Get API-intercepted profiles
    const apiProfiles = [...this.interceptedProfiles];
    this.interceptedProfiles = [];
    this.emit("log", `  → API intercepted: ${apiProfiles.length} profiles`);

    // 2. Scrape the DOM — with noise filtering
    const domProfiles = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Noise words to filter out of names
      const noisePatterns = [
        "is reachable",
        "Add .* to selection",
        "Save as lead",
        "Message",
        "Connect",
        "InMail",
        "View profile",
        "more option",
        "Expand",
        "Collapse",
      ];
      const noiseRegex = new RegExp(noisePatterns.join("|"), "i");

      // Find all lead links
      const leadLinks = document.querySelectorAll('a[href*="/sales/lead/"]');

      leadLinks.forEach((link) => {
        try {
          const href = link.getAttribute("href") || "";

          // Extract member URN from URL
          const urnMatch = href.match(/\/lead\/([A-Za-z0-9_-]+)/);
          if (!urnMatch) return;
          const memberUrn = urnMatch[1];

          if (seen.has(memberUrn)) return;
          seen.add(memberUrn);

          // Get the name — only from the link's direct text, filtering out noise
          // Get only the first text node or span that looks like a name
          let fullName = "";
          const nameSpans = link.querySelectorAll("span");
          for (const span of nameSpans) {
            const t = span.textContent?.trim() || "";
            if (
              t.length >= 2 &&
              t.length <= 50 &&
              !noiseRegex.test(t) &&
              !t.includes("…")
            ) {
              fullName = t.replace(/\s+/g, " ").trim();
              break;
            }
          }
          // Fallback: use direct text content but clean it
          if (!fullName) {
            const directText =
              link.textContent?.trim()?.replace(/\s+/g, " ") || "";
            // Take only the first "word-like" part (name), stop at noise
            const cleanMatch = directText.match(
              /^([A-Za-z\u00C0-\u024F\u0E00-\u0E7F\u4E00-\u9FFF\s.'-]{2,50})/
            );
            if (cleanMatch) {
              fullName = cleanMatch[1].trim();
              // Remove trailing noise
              fullName = fullName
                .replace(/\s*(is reachable|View profile).*$/i, "")
                .trim();
            }
          }
          if (!fullName || fullName.length < 2) return;

          // Walk up to the containing list item
          const card =
            link.closest("li") ||
            link.closest('[class*="result"]') ||
            link.parentElement?.parentElement?.parentElement;
          let title = "";
          let company = "";
          let location = "";

          if (card) {
            // Get all visible text spans/divs that are NOT inside buttons or action areas
            const textElements = card.querySelectorAll(
              '[class*="body-text"], [class*="subtitle"], [class*="caption"], [class*="lockup__subtitle"], [class*="lockup__caption"], [class*="lockup__metadata"]'
            );

            const texts = [];
            textElements.forEach((el) => {
              // Skip if inside a button or action container
              if (
                el.closest("button") ||
                el.closest('[class*="action"]') ||
                el.closest('[class*="select"]')
              )
                return;
              const t = el.textContent?.trim()?.replace(/\s+/g, " ") || "";
              if (t && t.length > 1 && t.length < 200 && !noiseRegex.test(t)) {
                texts.push(t);
              }
            });

            // If class-based selectors didn't find anything, try a broader approach
            if (texts.length === 0) {
              // Get all non-button, non-action text from the card
              const allSpans = card.querySelectorAll("span, div");
              allSpans.forEach((el) => {
                if (
                  el.closest("button") ||
                  el.closest('[role="button"]') ||
                  el.closest('[class*="action"]') ||
                  el.closest('[class*="select"]') ||
                  el.closest("nav")
                )
                  return;
                if (el.children.length > 2) return; // Skip containers
                const t = el.textContent?.trim()?.replace(/\s+/g, " ") || "";
                if (
                  t &&
                  t.length > 2 &&
                  t.length < 150 &&
                  !noiseRegex.test(t) &&
                  t !== fullName &&
                  !t.includes("Save") &&
                  !t.includes("Select") &&
                  !t.includes("Message")
                ) {
                  texts.push(t);
                }
              });
            }

            // Deduplicate and remove the name
            const uniqueTexts = [...new Set(texts)].filter(
              (t) => t !== fullName && !fullName.includes(t)
            );

            // Parse title/company/location from the remaining text
            for (const text of uniqueTexts) {
              // Title at Company
              if (!title && text.includes(" at ")) {
                const parts = text.split(" at ");
                title = parts[0].trim();
                company = parts.slice(1).join(" at ").trim();
                continue;
              }
              // First substantial text = likely title
              if (!title) {
                title = text;
                continue;
              }
              // Company (if not yet found)
              if (!company && !text.includes(",") && text.length < 60) {
                company = text;
                continue;
              }
              // Location (has comma, looks like "City, Country")
              if (!location && text.includes(",") && text.length < 80) {
                location = text;
              }
            }
          }

          // Premium / Open Link detection from DOM.
          // Sales Nav marks premium accounts with a gold "in" LinkedIn bug
          // icon next to the lead's name. We look for it inside the same
          // result card via a few selectors that have proven stable.
          let isPremium = false;
          let isOpenLink = false;
          const detectCard =
            link.closest("li") ||
            link.closest('[class*="result"]') ||
            link.parentElement?.parentElement?.parentElement;
          if (detectCard) {
            const haystack = (
              detectCard.outerHTML || ""
            ).toLowerCase();
            isPremium =
              detectCard.querySelector(
                '[data-test-icon*="premium"], [class*="premium"], [aria-label*="Premium" i], li-icon[type="linkedin-bug-color-premium"], li-icon[type="premium-app"]'
              ) !== null ||
              haystack.includes("premium-app") ||
              haystack.includes("premium subscriber") ||
              haystack.includes("inbug-color-gold") ||
              haystack.includes('aria-label="premium"');
            isOpenLink =
              detectCard.querySelector(
                '[data-test-icon*="open"], [aria-label*="Open Profile" i], [aria-label*="OpenLink" i]'
              ) !== null ||
              haystack.includes("openlink") ||
              haystack.includes("open_link");
          }

          results.push({
            fullName,
            firstName: "",
            lastName: "",
            title,
            company,
            location,
            profileUrl: href,
            memberUrn,
            isOpenLink,
            isPremium,
            source: "dom",
          });
        } catch (e) {
          /* skip */
        }
      });

      return results;
    });

    this.emit("log", `  → DOM scraper: ${domProfiles.length} profiles`);

    // 3. Merge — API data takes priority, DOM fills gaps
    const merged = new Map();

    for (const p of apiProfiles) {
      if (p.memberUrn) merged.set(p.memberUrn, p);
    }

    for (const p of domProfiles) {
      if (!p.memberUrn) continue;
      if (merged.has(p.memberUrn)) {
        const existing = merged.get(p.memberUrn);
        if (!existing.company && p.company) existing.company = p.company;
        if (!existing.location && p.location) existing.location = p.location;
        if (!existing.title && p.title) existing.title = p.title;
        if (!existing.fullName && p.fullName) existing.fullName = p.fullName;
        if (!existing.profileUrl && p.profileUrl)
          existing.profileUrl = p.profileUrl;
        // Premium / OpenLink: OR the values so a hit from EITHER source wins.
        // The API path frequently misses these flags (LinkedIn changes the
        // response shape) and the DOM badge is more reliable in practice.
        if (p.isPremium) existing.isPremium = true;
        if (p.isOpenLink) existing.isOpenLink = true;
      } else {
        merged.set(p.memberUrn, p);
      }
    }

    // 4. Split names
    const profiles = Array.from(merged.values()).map((p) => {
      if (p.fullName && !p.firstName) {
        const parts = p.fullName.trim().split(/\s+/);
        p.firstName = parts[0] || "";
        p.lastName = parts.slice(1).join(" ") || "";
      }
      return p;
    });

    return profiles;
  }

  // ─── Page Helpers ─────────────────────────────────────────────
  async scrollResults(page) {
    await page.evaluate(async () => {
      const container =
        document.querySelector(".search-results__result-list") ||
        document.querySelector('[class*="search-results"]') ||
        document.querySelector("ol") ||
        document.documentElement;
      for (let i = 0; i < 10; i++) {
        container.scrollBy(0, 400);
        await new Promise((r) => setTimeout(r, 300));
      }
      container.scrollTo(0, 0);
    });
    await new Promise((r) => setTimeout(r, 1500));
  }

  async waitForResults(page) {
    const selectors = [
      'a[href*="/sales/lead/"]',
      ".search-results__result-list",
      'ol[class*="search"]',
      "li.artdeco-list__item",
    ];
    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        return true;
      } catch (e) {
        /* try next */
      }
    }
    this.emit("log", "  → No results container found, waiting extra…");
    await new Promise((r) => setTimeout(r, 10000));
    return false;
  }

  async isThrottled(page) {
    // Check if we got a 429 from the network interceptor
    if (this.rateLimited) {
      this.rateLimited = false; // reset for next check
      return true;
    }

    return page.evaluate(() => {
      const bodyText = document.body?.innerText?.toLowerCase() || "";
      const url = window.location.href.toLowerCase();
      if (
        url.includes("/checkpoint/challenge") ||
        url.includes("/checkpoint/lg/")
      )
        return true;
      const signals = [
        "let's do a quick security check",
        "unusual activity",
        "we've detected unusual activity",
        "your account has been restricted",
        "please verify your identity",
        "too many requests",
        "you've reached the",
        "commercial use limit",
      ];
      return signals.some((s) => bodyText.includes(s));
    });
  }

  // Direct-API pagination: replay the captured Sales Nav search request at a
  // paging offset, IN-PAGE (page.evaluate → fetch carries the live session
  // cookies + csrf-token header), and parse the profiles. Format-agnostic: works
  // for #query= fragment URLs where UI navigation can't advance the page. Returns
  // a profiles array (possibly empty at end-of-results), or null when no API was
  // captured / the request failed — in which case the caller falls back to UI
  // navigation. Retries once on a 429.
  async _fetchApiPage(page, startOffset) {
    const api = this._searchApi;
    if (!api) return null;
    const url = bumpStart(api.url, startOffset);
    const body = api.postData ? bumpStart(api.postData, startOffset) : null;
    // Diagnostic (once, at the first paged offset): confirm the `start` offset
    // actually spliced somewhere — if not, this request paginates by a param we
    // don't recognise and direct-API would just refetch page 1.
    if (startOffset === SEARCH_PAGE_SIZE) {
      const urlBumped = url !== api.url;
      const bodyBumped = body != null && body !== api.postData;
      this.emit(
        "log",
        urlBumped || bodyBumped
          ? `  → direct-API start offset spliced into ${bodyBumped ? "body" : "url"}`
          : "  → WARN: no `start` offset found in the search request — direct-API may not advance"
      );
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      // NOTE: page.evaluate args must be wrapped in ONE object — this puppeteer
      // build rejects multiple positional args ("Too many arguments…").
      const result = await page
        .evaluate(
          async ({ u, method, headers, b }) => {
            try {
              const res = await fetch(u, {
                method,
                headers,
                body: b || undefined,
                credentials: "include",
              });
              const text = await res.text();
              let json = null;
              try {
                json = JSON.parse(text);
              } catch (_) {}
              return { ok: res.ok, status: res.status, json };
            } catch (e) {
              return { ok: false, status: 0, error: String((e && e.message) || e) };
            }
          },
          { u: url, method: api.method, headers: api.headers, b: body }
        )
        .catch((e) => ({ ok: false, status: 0, error: e.message }));

      if (result && result.status === 429) {
        this.rateLimited = true;
        this.emit("log", "🚫  API rate limited (429) — waiting 60s before retrying this page…");
        await new Promise((r) => setTimeout(r, 60000));
        continue;
      }
      if (!result || !result.ok || !result.json) {
        this.emit(
          "log",
          `  → direct-API fetch failed (status ${result && result.status}${result && result.error ? ", " + result.error : ""})`
        );
        return null;
      }
      return this.parseApiResponse(result.json);
    }
    return null; // still 429 after the retry
  }

  // Click the paginator to advance to `pageNum` — the legacy navigation, kept as
  // the hybrid fallback for searches where URL nav (&page=N) doesn't advance.
  // Returns "page-btn" | "next-btn" | "none".
  async _clickToPage(page, pageNum) {
    return await page.evaluate((target) => {
      // Click the numbered page button (inside a paginator container)…
      const btns = document.querySelectorAll("button");
      for (const btn of btns) {
        if (
          btn.textContent.trim() === String(target) &&
          btn.closest('[class*="pagination"], [class*="page"]')
        ) {
          btn.click();
          return "page-btn";
        }
      }
      // …else fall back to the Next button.
      const nextBtns = document.querySelectorAll(
        'button[aria-label*="Next"], button[aria-label*="next"]'
      );
      for (const btn of nextBtns) {
        if (!btn.disabled) {
          btn.click();
          return "next-btn";
        }
      }
      return "none";
    }, pageNum);
  }

  // Let a freshly-navigated results page render, then scroll to trigger the lazy
  // Voyager fetches the network interceptor captures.
  async _settlePage(page) {
    await new Promise((r) => setTimeout(r, 5000));
    await this.waitForResults(page);
    await this.scrollResults(page);
    await new Promise((r) => setTimeout(r, 2000));
  }

  async getTotalResults(page) {
    return page.evaluate(() => {
      const allText = document.body?.innerText || "";
      const match = allText.match(/([\d,]+)\s*(?:total\s+)?result/i);
      if (match) return parseInt(match[1].replace(/,/g, ""), 10);
      const headers = document.querySelectorAll('h1, h2, h3, [role="heading"]');
      for (const h of headers) {
        const m = h.textContent.match(/([\d,]+)/);
        if (m) {
          const num = parseInt(m[0].replace(/,/g, ""), 10);
          if (num > 0 && num < 100000) return num;
        }
      }
      return 0;
    });
  }

  // ─── Main Scrape Flow ─────────────────────────────────────────
  async scrapeSingle({ searchUrl, sheetUrl, tabName }) {
    this.stopped = false;
    this.paused = false;
    this.totalProfiles = 0;
    this.totalPages = 0;
    this.interceptedProfiles = [];

    const { getBrowser, closeBrowser } = require("./browser");

    // Open the scraping page with auto-recovery: if the cached browser
    // context is dead (Chromium crashed mid-session, OOM, etc) recycle
    // it and try again. Without this, we'd surface
    // "Target.createTarget: Failed to open a new tab" to the user.
    const openScrapePage = async () => {
      const ctx = await getBrowser(this.profileId);
      // Open the scrape page FIRST, then close stale tabs. Orbita (Chromium)
      // quits when its LAST tab closes, so closing every existing tab before
      // opening a new one would kill the browser and make newPage() fail with
      // "Target page, context or browser has been closed".
      const existing = ctx.pages();
      const page = await ctx.newPage();
      for (const p of existing) {
        try {
          await p.close();
        } catch (_) {}
      }
      return page;
    };

    try {
      this.emit("log", "Starting scrape…");
      this.emit("status", { state: "running", page: 0, profiles: 0 });
      // Pagination state for THIS scrape.
      //  _searchApi   — the captured Sales Nav search API request (set by the
      //                 network interceptor on page 1); replayed with paging
      //                 offsets for direct-API pagination.
      //  _apiPagingOk — undefined → try direct-API at page 2; true → committed to
      //                 it; false → it didn't work, use UI navigation instead.
      //  _urlNavOk    — UI-fallback sub-mode: undefined/true → URL nav (&page=N);
      //                 false → legacy button-click (see the loop).
      this._searchApi = null;
      this._apiPagingOk = undefined;
      this._urlNavOk = undefined;

      let page;
      try {
        page = await openScrapePage();
      } catch (err) {
        const m = String(err?.message || "");
        const recoverable =
          m.includes("Target.createTarget") ||
          m.includes("Failed to open a new tab") ||
          m.includes("Target closed") ||
          m.includes("browserContext.newPage") ||
          m.includes("has been closed");
        if (!recoverable) throw err;
        this.emit(
          "log",
          "Browser context was stale — recycling and retrying…"
        );
        try {
          await closeBrowser(this.profileId);
        } catch (_) {}
        page = await openScrapePage();
      }
      this.page = page;

      // Set up network interception BEFORE navigation
      this.setupNetworkInterception(page);

      // Navigate to search URL
      this.emit("log", "Navigating to Sales Navigator…");
      try {
        await page.goto(searchUrl, { waitUntil: "commit", timeout: 60000 });
      } catch (navErr) {
        if (!navErr.message.includes("ERR_ABORTED")) throw navErr;
        this.emit("log", "  → SPA redirect — waiting for page…");
      }

      // Wait for page to render
      await new Promise((r) => setTimeout(r, 8000));

      // Check page is alive
      let currentUrl;
      try {
        currentUrl = page.url();
      } catch (e) {
        return { success: false, reason: "Page crashed — try again" };
      }

      this.emit("log", `Page loaded: ${currentUrl.substring(0, 100)}…`);

      // ─── Contract-chooser handling ──────────────────────────────────
      // First scrape after login for users with multiple Sales Nav
      // contracts often lands on /sales/contract-chooser instead of the
      // search results. Click the primary "Continue" / contract card and
      // re-navigate to the original search URL.
      if (currentUrl.includes("/sales/contract-chooser")) {
        this.emit("log", "  → Contract chooser detected — selecting a contract…");
        const clicked = await page
          .evaluate(() => {
            const sels = [
              'button[data-test-contract-chooser-card]',
              '[data-test-contract-chooser] button',
              'button[type="submit"]',
              'main button',
              'a[href*="/sales/homepage"]',
            ];
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) {
                el.click();
                return s;
              }
            }
            return "";
          })
          .catch(() => "");
        this.emit("log", `  → Clicked: ${clicked || "(no selector matched)"}`);

        // Wait for the redirect after click
        await new Promise((r) => setTimeout(r, 5000));

        // If we're still on the chooser, force-navigate to the original URL
        // (LinkedIn often remembers the chooser selection on subsequent loads).
        if (page.url().includes("contract-chooser")) {
          this.emit("log", "  → Still on chooser — re-navigating to search URL…");
          try {
            await page.goto(searchUrl, {
              waitUntil: "commit",
              timeout: 60000,
            });
          } catch (e) {
            if (!e.message.includes("ERR_ABORTED")) throw e;
          }
          await new Promise((r) => setTimeout(r, 8000));
        }

        currentUrl = page.url();
        this.emit("log", `  → Now at: ${currentUrl.substring(0, 100)}…`);
      }

      // Auth check
      if (
        currentUrl.includes("/login") ||
        currentUrl.includes("/authwall") ||
        currentUrl.includes("guest_login") ||
        currentUrl.includes("/premium/products")
      ) {
        this.emit("log", "❌  Not logged in. Reconnect LinkedIn.");
        return { success: false, reason: "Session expired" };
      }

      // Throttle check
      if (await this.isThrottled(page)) {
        this.emit("log", "🚫  LinkedIn is rate limiting this account — too many requests. Wait 15-30 minutes before trying again, or switch to a different LinkedIn account.");
        this.emit("status", { state: "throttled", page: 0, profiles: 0 });
        return { success: false, reason: "Rate limited — too many requests. Wait 15-30 minutes." };
      }

      // Wait for results
      this.emit("log", "Waiting for results…");
      await this.waitForResults(page);
      await this.scrollResults(page);

      // Give the API interceptor a moment to process responses
      await new Promise((r) => setTimeout(r, 2000));

      const totalResults = await this.getTotalResults(page);
      this.emit("log", `Result count: ${totalResults}`);

      // Extract page 1
      const firstPageProfiles = await this.extractProfiles(page);
      this.emit("log", `Page 1: ${firstPageProfiles.length} profiles`);

      // Filter out anything we've already written this scrape — prevents
      // duplicate rows when LinkedIn returns the same payload twice.
      const firstPageNew = firstPageProfiles.filter(
        (p) => p.memberUrn && !this.writtenUrns.has(p.memberUrn)
      );

      if (firstPageNew.length > 0) {
        try {
          await sendToSheet({ profiles: firstPageNew, sheetUrl, tabName });
          this.emit(
            "log",
            `  → Sent ${firstPageNew.length} rows to sheet${
              firstPageNew.length !== firstPageProfiles.length
                ? ` (${firstPageProfiles.length - firstPageNew.length} duplicates skipped)`
                : ""
            }`
          );
          for (const p of firstPageNew) this.writtenUrns.add(p.memberUrn);
          this.totalProfiles += firstPageNew.length;
        } catch (err) {
          if (isPermissionError(err)) {
            const email = getServiceAccountEmail();
            this.emit(
              "log",
              `🚫  Sheet not shared with service account — stopping scrape.`
            );
            this.emit("sheet-permission-error", {
              sheetUrl,
              tabName,
              serviceAccountEmail: email,
              message: err.message,
            });
            this.emit("status", {
              state: "error",
              page: this.totalPages,
              profiles: this.totalProfiles,
              error: "Sheet permission denied",
            });
            return {
              success: false,
              reason:
                "Sheet permission denied — share the destination sheet with " +
                (email || "the service account email") +
                " and try again.",
              profiles: this.totalProfiles,
              pages: this.totalPages,
            };
          }
          this.emit("log", `  ⚠️  Sheet error: ${err.message}`);
          for (const p of firstPageNew) this.writtenUrns.add(p.memberUrn);
          this.totalProfiles += firstPageNew.length;
        }
      }

      this.totalPages = 1;
      this.emit("status", {
        state: "running",
        page: 1,
        profiles: this.totalProfiles,
      });

      // Determine pagination
      let maxPages;
      if (totalResults > 0) {
        maxPages = Math.min(Math.ceil(totalResults / 25), 100);
      } else if (firstPageProfiles.length > 0) {
        maxPages = 100;
        this.emit("log", "No count — will paginate until empty");
      } else {
        // Debug
        const debug = await page.evaluate(() => ({
          title: document.title,
          leadLinks: document.querySelectorAll('a[href*="/sales/lead/"]')
            .length,
          text: document.body?.innerText?.substring(0, 200) || "",
        }));
        this.emit(
          "log",
          `  Debug: title="${debug.title}", links=${debug.leadLinks}`
        );
        this.emit("log", `  Debug: ${debug.text.substring(0, 150)}…`);
        maxPages = 0;
      }

      // Guard against a wrong/low result-count read. If page 1 came back FULL
      // (a complete page of 25) but the count says the search is tiny (≤ 2
      // pages), that count is almost certainly misread — a transient throttle,
      // a slow-rendering count, or the regex matching the wrong number. A
      // genuinely tiny search would NOT fill page 1 to 25. So don't trust it:
      // paginate until the results actually run out (an empty page), bounded by
      // the Sales Nav 100-page / 2,500-result ceiling. (This is what truncated
      // a teammate's batch to 25 rows — the count read low and we stopped.)
      if (firstPageProfiles.length >= 25 && maxPages > 0 && maxPages <= 2) {
        this.emit(
          "log",
          `  → Result count (${totalResults}) looks too low for a full first page — ignoring it and paginating until empty`
        );
        maxPages = 100;
      }

      // Pages 2+
      for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
        await this.waitWhilePaused();
        if (this.stopped) break;

        this.emit(
          "log",
          `Scraping page ${pageNum}${maxPages < 100 ? "/" + maxPages : ""}…`
        );

        // Clear intercepted data for this page
        this.interceptedProfiles = [];

        let profiles = null;
        let usedApi = false;

        // ── PRIMARY: direct-API pagination ──────────────────────────────────
        // Replay the captured Sales Nav search request at this page's offset. It
        // pulls the REAL result set (up to the 2,500 cap) and is FORMAT-AGNOSTIC —
        // it works for #query= fragment search URLs, where UI navigation can't
        // advance the page and caps every scrape at ~200 (audit 2026-07-14).
        // Decided at page 2, then committed for the rest of the scrape.
        if (this._apiPagingOk !== false && this._searchApi) {
          const start = (pageNum - 1) * SEARCH_PAGE_SIZE;
          const apiProfiles = await this._fetchApiPage(page, start);
          if (apiProfiles && apiProfiles.length > 0) {
            this._apiPagingOk = true;
            profiles = apiProfiles;
            usedApi = true;
            this.emit("log", `  → page ${pageNum}: direct API (start=${start}) → ${apiProfiles.length} profiles`);
          } else if (this._apiPagingOk === true) {
            // Was working; now empty/failed → end of results (the guards stop us).
            profiles = apiProfiles || [];
            usedApi = true;
            this.emit("log", `  → page ${pageNum}: direct API returned ${profiles.length} — end of results`);
          } else {
            // Page 2 and direct-API didn't yield — disable it, use UI navigation.
            this._apiPagingOk = false;
            this.emit("log", "  → direct-API pagination unavailable for this search — using UI navigation");
          }
        }

        // ── FALLBACK: UI navigation (v51 URL→button hybrid) ─────────────────
        // Only when direct-API isn't in play. URL nav (&page=N) lifts the cap
        // where Sales Nav honours the param; on searches that ignore it we drop to
        // the legacy button-click — never worse than the old ~200.
        if (!usedApi) {
          if (this._urlNavOk === false) {
            const navd = await this._clickToPage(page, pageNum);
            this.emit("log", `  → page ${pageNum}: button nav (${navd})`);
          } else {
            const targetUrl = withPage(searchUrl, pageNum);
            try {
              await page.goto(targetUrl, { waitUntil: "commit", timeout: 60000 });
            } catch (navErr) {
              if (!String(navErr.message).includes("ERR_ABORTED")) throw navErr;
            }
            this.emit("log", `  → page ${pageNum}: URL nav (&page=${pageNum})`);
          }
          await this._settlePage(page);

          if (await this.isThrottled(page)) {
            this.emit("log", "🚫  LinkedIn rate limit hit at page " + pageNum + ". Waiting 60 seconds before retrying…");
            this.emit("status", { state: "throttle-wait", page: this.totalPages, profiles: this.totalProfiles });
            await new Promise((r) => setTimeout(r, 60000));
            await page.reload({ waitUntil: "domcontentloaded" });
            await new Promise((r) => setTimeout(r, 3000));
            if (await this.isThrottled(page)) {
              this.emit("log", "🚫  Still rate limited after waiting. Stopping scrape. Got " + this.totalProfiles + " profiles so far. Wait 15-30 minutes before trying again.");
              return {
                success: false,
                reason: "Rate limited — scraped " + this.totalProfiles + " profiles before being blocked. Wait 15-30 minutes.",
                profiles: this.totalProfiles,
                pages: this.totalPages,
              };
            }
            this.emit("log", "✅  Rate limit cleared — resuming scrape.");
          }

          profiles = await this.extractProfiles(page);
          const newP = profiles.filter(
            (p) => p.memberUrn && !this.writtenUrns.has(p.memberUrn)
          );
          // URL nav produced nothing new → try the button-click for this page
          // before trusting the empty/stuck guards; if it advances, commit to it.
          if (this._urlNavOk !== false && newP.length === 0) {
            this.emit("log", "  → URL nav returned no new profiles — trying button navigation");
            this.interceptedProfiles = [];
            const navd = await this._clickToPage(page, pageNum);
            this.emit("log", `  → fallback click: ${navd}`);
            await this._settlePage(page);
            const clicked = await this.extractProfiles(page);
            const clickedNew = clicked.filter(
              (p) => p.memberUrn && !this.writtenUrns.has(p.memberUrn)
            );
            if (clickedNew.length > 0) {
              this._urlNavOk = false; // this search ignores &page=N — use clicks
              profiles = clicked;
              this.emit("log", "  → button nav works for this search — switching to button pagination for the rest");
            }
          }
        }

        profiles = profiles || [];
        // Filter out anything we've already written this scrape (dupe pages).
        const newProfiles = profiles.filter(
          (p) => p.memberUrn && !this.writtenUrns.has(p.memberUrn)
        );

        this.emit(
          "log",
          `  → ${profiles.length} profiles from page ${pageNum}`
        );

        if (newProfiles.length > 0) {
          try {
            await sendToSheet({ profiles: newProfiles, sheetUrl, tabName });
            this.emit(
              "log",
              `  → Sent ${newProfiles.length} rows${
                newProfiles.length !== profiles.length
                  ? ` (${profiles.length - newProfiles.length} duplicates skipped)`
                  : ""
              }`
            );
            for (const p of newProfiles) this.writtenUrns.add(p.memberUrn);
            this.totalProfiles += newProfiles.length;
            this.consecutiveDupePages = 0;
          } catch (err) {
            if (isPermissionError(err)) {
              const email = getServiceAccountEmail();
              this.emit(
                "log",
                `🚫  Sheet not shared with service account — stopping scrape.`
              );
              this.emit("sheet-permission-error", {
                sheetUrl,
                tabName,
                serviceAccountEmail: email,
                message: err.message,
              });
              this.emit("status", {
                state: "error",
                page: this.totalPages,
                profiles: this.totalProfiles,
                error: "Sheet permission denied",
              });
              return {
                success: false,
                reason:
                  "Sheet permission denied — share the destination sheet with " +
                  (email || "the service account email") +
                  " and try again.",
                profiles: this.totalProfiles,
                pages: this.totalPages,
              };
            }
            this.emit("log", `  ⚠️  Sheet error: ${err.message}`);
            for (const p of newProfiles) this.writtenUrns.add(p.memberUrn);
            this.totalProfiles += newProfiles.length;
            this.consecutiveDupePages = 0;
          }
        } else if (profiles.length === 0) {
          this.emit("log", "  → Empty page — stopping");
          break;
        } else {
          // Pagination returned only urns we've already written — pagination
          // is stuck on the same page. Bail after a couple of these so we
          // don't loop the rest of maxPages writing nothing useful.
          this.consecutiveDupePages++;
          this.emit(
            "log",
            `  → All ${profiles.length} profiles already seen (pagination may not be advancing)`
          );
          if (this.consecutiveDupePages >= 2) {
            this.emit(
              "log",
              "  → Pagination appears stuck — stopping to avoid duplicate rows"
            );
            break;
          }
        }

        this.totalPages = pageNum;
        this.emit("status", {
          state: "running",
          page: this.totalPages,
          profiles: this.totalProfiles,
        });

        if (pageNum < maxPages) await this.delay();
      }

      this.emit(
        "log",
        `✅ Done. ${this.totalProfiles} profiles, ${this.totalPages} pages.`
      );
      this.emit("status", {
        state: "done",
        page: this.totalPages,
        profiles: this.totalProfiles,
      });
      return {
        success: true,
        profiles: this.totalProfiles,
        pages: this.totalPages,
      };
    } catch (err) {
      // If user clicked Stop, the page closes and throws — that's not an error
      if (this.stopped) {
        this.emit("log", `⏹  Scrape stopped. ${this.totalProfiles} profiles scraped so far.`);
        this.emit("status", {
          state: "stopped",
          page: this.totalPages,
          profiles: this.totalProfiles,
        });
        return {
          success: true,
          profiles: this.totalProfiles,
          pages: this.totalPages,
        };
      }

      this.emit("log", `❌  Error: ${err.message}`);
      this.emit("status", {
        state: "error",
        page: this.totalPages,
        profiles: this.totalProfiles,
        error: err.message,
      });
      return { success: false, reason: err.message };
    } finally {
      // Always close the page
      try {
        if (this.page) await this.page.close();
      } catch (e) {}

      // Close and reset the entire browser context to prevent stale state
      try {
        const { closeBrowser } = require("./browser");
        await closeBrowser(this.profileId);
      } catch (e) {}
    }
  }
}

module.exports = Scraper;
module.exports.withPage = withPage; // exposed for unit tests
module.exports.bumpStart = bumpStart; // exposed for unit tests
