const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const { scrapeAndCompare } = require('./scraper');

const app = express();
const PORT = 3000;

app.use(cors());

app.get('/api/stats', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const result = await scrapeAndCompare(browser);
    res.json(result);
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Phillies stats server running on http://localhost:${PORT}`);
});
