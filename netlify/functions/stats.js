const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { scrapeAndCompare } = require('../../server/scraper');

exports.handler = async () => {
  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-blink-features=AutomationControlled',
        '--disable-features=site-per-process',
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const result = await scrapeAndCompare(browser);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Stats function error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: err.message,
        hint: 'Check Netlify function logs for details.',
      }),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
