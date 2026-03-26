const express = require('express');
const cors = require('cors');
const { scrapeAndCompare } = require('./scraper');

const app = express();
const PORT = 3000;

app.use(cors());

app.get('/api/stats', async (req, res) => {
  try {
    const result = await scrapeAndCompare();
    res.json(result);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Phillies stats server running on http://localhost:${PORT}`);
});
