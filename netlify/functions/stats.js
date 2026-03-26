const { scrapeAndCompare } = require('../../server/scraper');

// v2 — counting stats projected to 162-game pace
exports.handler = async () => {
  try {
    const result = await scrapeAndCompare();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Stats function error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
