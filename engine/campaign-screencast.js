// campaign-screencast.js
//
// CDP screencast → JPEG frames for a CAMPAIGN browser page. Byte-for-byte the
// scraper's startScreencast (scraper.js) EXCEPT the CDP session accessor:
// campaigns run Puppeteer (page.target().createCDPSession()), the scraper runs
// Playwright (page.context().newCDPSession(page)). The CDP wire commands are
// identical. Returns an async stop().
async function campaignScreencast(page, onFrame, { quality = 50, maxWidth = 1280, maxHeight = 800 } = {}) {
  const noop = async () => {};
  if (!page) return noop;

  let client;
  try { client = await page.target().createCDPSession(); } // Puppeteer
  catch (_) { return noop; }

  const onFrameEvt = async ({ data, sessionId }) => {
    try { onFrame(Buffer.from(data, "base64")); } catch (_) {}
    try { await client.send("Page.screencastFrameAck", { sessionId }); } catch (_) {}
  };
  client.on("Page.screencastFrame", onFrameEvt);

  try {
    await client.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
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

module.exports = { campaignScreencast };
