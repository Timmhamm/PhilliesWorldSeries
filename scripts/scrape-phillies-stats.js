// Standalone runner — calls the same scraper used by the Express server
const { scrapeAndCompare } = require('../server/scraper');
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '../src/assets/comparison-result.json');

scrapeAndCompare()
  .then(result => {
    fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
    console.log(`Verdict: "${result.verdict}"`);
    console.log(`Phillies categories won: ${result.category_wins.phillies}/${result.comparisons.length}`);
    console.log(`Saved to ${OUTPUT}`);
  })
  .catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
