const PHILLIES_URL = 'https://www.baseball-reference.com/teams/PHI/2026.shtml';
const DODGERS_URL  = 'https://www.baseball-reference.com/teams/LAD/2025.shtml';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

async function scrapeTeam(url, browser) {
  const page = await browser.newPage();

  // Mask automation signals to avoid bot detection
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Baseball Reference hides some tables in comments — unhide them via JS
  await page.evaluate(() => {
    document.querySelectorAll('.section_wrapper div.table_outer_container').forEach(el => {
      el.style.display = 'block';
    });
  });

  // Wait for at least one stats table to be present
  await page.waitForSelector('#players_standard_batting, #team_batting', { timeout: 8000 })
    .catch(() => {});

  const data = await page.evaluate(() => {
    const parseTable = (tableId) => {
      const table = document.querySelector(`#${tableId}`);
      if (!table) return [];
      const headers = Array.from(table.querySelectorAll('thead tr:last-child th, thead tr:last-child td'))
        .map(th => th.getAttribute('data-stat') || th.textContent.trim());
      return Array.from(table.querySelectorAll('tbody tr'))
        .filter(row => !row.classList.contains('thead') && !row.classList.contains('spacer'))
        .map(row => {
          const obj = {};
          Array.from(row.querySelectorAll('td, th')).forEach((cell, i) => {
            const key = cell.getAttribute('data-stat') || headers[i] || `col_${i}`;
            obj[key] = cell.textContent.trim();
          });
          return obj;
        })
        .filter(row => Object.values(row).some(v => v && v !== ''));
    };

    return {
      batting:  parseTable('players_standard_batting'),
      pitching: parseTable('players_standard_pitching'),
    };
  });

  await page.close();
  return data;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const toFloat = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const toInt   = v => { const n = parseInt(v);   return isNaN(n) ? null : n; };

function parseBatter(row) {
  return {
    name: row.player || row.name_display || '?',
    PA:   toInt(row.PA)   || 0,
    HR:   toInt(row.HR)   || 0,
    BB:   toInt(row.BB)   || 0,
    SO:   toInt(row.SO)   || 0,
    SB:   toInt(row.SB)   || 0,
    BA:   toFloat(row.batting_avg),
    OBP:  toFloat(row.onbase_perc),
    SLG:  toFloat(row.slugging_perc),
    OPS:  toFloat(row.onbase_plus_slugging),
  };
}

function parsePitcher(row) {
  const ip = toFloat(row.IP) || 0;
  const so = toInt(row.SO)   || 0;
  const bb = toInt(row.BB)   || 0;
  return {
    name: row.player || row.name_display || '?',
    IP:   ip,
    ERA:  toFloat(row.earned_run_avg),
    WHIP: toFloat(row.whip),
    H9:   toFloat(row['H/9'] || row.hits_per_nine),
    HR9:  toFloat(row['HR/9'] || row.hr_per_nine),
    BB9:  toFloat(row['BB/9'] || row.bb_per_nine),
    SO9:  toFloat(row['SO/9'] || row.so_per_nine),
    SOBB: bb > 0 ? so / bb : so > 0 ? so : null,
  };
}

// ---------------------------------------------------------------------------
// Weighted averaging
// ---------------------------------------------------------------------------

function weightedAvg(players, statKey, weightKey) {
  const qualified = players.filter(p => p[statKey] !== null && p[weightKey] > 0);
  const totalWeight = qualified.reduce((sum, p) => sum + p[weightKey], 0);
  if (totalWeight === 0) return null;
  return qualified.reduce((sum, p) => sum + p[statKey] * p[weightKey], 0) / totalWeight;
}

function sumStat(players, statKey) {
  return players.reduce((sum, p) => sum + (p[statKey] || 0), 0);
}

// ---------------------------------------------------------------------------
// Team score calculation
// ---------------------------------------------------------------------------

function offenseScore(batters) {
  const qualified = batters.filter(p => p.PA >= 50);
  if (!qualified.length) return null;
  const OPS = weightedAvg(qualified, 'OPS', 'PA');
  const OBP = weightedAvg(qualified, 'OBP', 'PA');
  const SLG = weightedAvg(qualified, 'SLG', 'PA');
  if (OPS === null) return null;
  return OPS * 0.50 + OBP * 0.30 + SLG * 0.20;
}

function pitchingScore(pitchers) {
  const qualified = pitchers.filter(p => p.IP >= 10);
  if (!qualified.length) return null;
  const ERA  = weightedAvg(qualified, 'ERA',  'IP');
  const WHIP = weightedAvg(qualified, 'WHIP', 'IP');
  const SOBB = weightedAvg(qualified, 'SOBB', 'IP');
  const BB9  = weightedAvg(qualified, 'BB9',  'IP');
  const HR9  = weightedAvg(qualified, 'HR9',  'IP');
  if (!ERA || !WHIP) return null;
  return (1 / ERA)  * 0.30 +
         (1 / WHIP) * 0.25 +
         (SOBB || 0) * 0.20 +
         (BB9  ? 1 / BB9  : 0) * 0.15 +
         (HR9  ? 1 / HR9  : 0) * 0.10;
}

// ---------------------------------------------------------------------------
// Build team summary
// ---------------------------------------------------------------------------

function buildTeamSummary(rawBatting, rawPitching) {
  const batters  = rawBatting.map(parseBatter).filter(p => p.PA > 0);
  const pitchers = rawPitching.map(parsePitcher).filter(p => p.IP > 0);
  const qualBatters  = batters.filter(p => p.PA >= 50);
  const qualPitchers = pitchers.filter(p => p.IP >= 10);

  return {
    batting: {
      OPS: weightedAvg(qualBatters, 'OPS', 'PA'),
      OBP: weightedAvg(qualBatters, 'OBP', 'PA'),
      SLG: weightedAvg(qualBatters, 'SLG', 'PA'),
      BA:  weightedAvg(qualBatters, 'BA',  'PA'),
      HR:  sumStat(batters, 'HR'),
      BB:  sumStat(batters, 'BB'),
      SO:  sumStat(batters, 'SO'),
      SB:  sumStat(batters, 'SB'),
    },
    pitching: {
      ERA:  weightedAvg(qualPitchers, 'ERA',  'IP'),
      WHIP: weightedAvg(qualPitchers, 'WHIP', 'IP'),
      SO9:  weightedAvg(qualPitchers, 'SO9',  'IP'),
      BB9:  weightedAvg(qualPitchers, 'BB9',  'IP'),
      HR9:  weightedAvg(qualPitchers, 'HR9',  'IP'),
      SOBB: weightedAvg(qualPitchers, 'SOBB', 'IP'),
    },
    offenseScore:  offenseScore(batters),
    pitchingScore: pitchingScore(pitchers),
    playerCount: { batters: qualBatters.length, pitchers: qualPitchers.length },
  };
}

// ---------------------------------------------------------------------------
// Category-by-category comparison
// ---------------------------------------------------------------------------

function compareStats(phillies, dodgers) {
  const comparisons = [];
  const add = (label, phiVal, ladVal, higherIsBetter, fmt = v => v?.toFixed(3) ?? 'N/A') => {
    if (phiVal == null || ladVal == null) return;
    const phiBetter = higherIsBetter ? phiVal > ladVal : phiVal < ladVal;
    comparisons.push({ label, phillies: fmt(phiVal), dodgers: fmt(ladVal), phillies_better: phiBetter });
  };
  const fmt3 = v => v?.toFixed(3) ?? 'N/A';
  const fmt1 = v => v?.toFixed(1) ?? 'N/A';
  const fmtI = v => v != null ? String(Math.round(v)) : 'N/A';

  add('OPS',               phillies.batting.OPS,  dodgers.batting.OPS,  true,  fmt3);
  add('OBP',               phillies.batting.OBP,  dodgers.batting.OBP,  true,  fmt3);
  add('SLG',               phillies.batting.SLG,  dodgers.batting.SLG,  true,  fmt3);
  add('Batting Avg',       phillies.batting.BA,   dodgers.batting.BA,   true,  fmt3);
  add('Home Runs',         phillies.batting.HR,   dodgers.batting.HR,   true,  fmtI);
  add('Walks (BB)',        phillies.batting.BB,   dodgers.batting.BB,   true,  fmtI);
  add('Strikeouts (batt)', phillies.batting.SO,   dodgers.batting.SO,   false, fmtI);
  add('Stolen Bases',      phillies.batting.SB,   dodgers.batting.SB,   true,  fmtI);
  add('ERA',               phillies.pitching.ERA,  dodgers.pitching.ERA,  false, fmt3);
  add('WHIP',              phillies.pitching.WHIP, dodgers.pitching.WHIP, false, fmt3);
  add('SO/9',              phillies.pitching.SO9,  dodgers.pitching.SO9,  true,  fmt1);
  add('BB/9',              phillies.pitching.BB9,  dodgers.pitching.BB9,  false, fmt1);
  add('HR/9',              phillies.pitching.HR9,  dodgers.pitching.HR9,  false, fmt1);
  add('SO/BB',             phillies.pitching.SOBB, dodgers.pitching.SOBB, true,  fmt3);
  return comparisons;
}

// ---------------------------------------------------------------------------
// Main export — accepts an externally created browser instance
// ---------------------------------------------------------------------------

async function scrapeAndCompare(browser) {
  console.log(`[${new Date().toISOString()}] Scraping both teams...`);

  const [philliesRaw, dodgersRaw] = await Promise.all([
    scrapeTeam(PHILLIES_URL, browser),
    scrapeTeam(DODGERS_URL,  browser),
  ]);

  console.log(`[${new Date().toISOString()}] Scrape complete.`);

  const phillies = buildTeamSummary(philliesRaw.batting, philliesRaw.pitching);
  const dodgers  = buildTeamSummary(dodgersRaw.batting,  dodgersRaw.pitching);
  const comparisons = compareStats(phillies, dodgers);

  const phiTotal = (phillies.offenseScore || 0) + (phillies.pitchingScore || 0);
  const ladTotal = (dodgers.offenseScore  || 0) + (dodgers.pitchingScore  || 0);
  const philliesCategoryWins = comparisons.filter(c => c.phillies_better).length;
  const dodgersCategoryWins  = comparisons.filter(c => !c.phillies_better).length;
  const philliesBetter = phiTotal !== ladTotal
    ? phiTotal > ladTotal
    : philliesCategoryWins >= dodgersCategoryWins;

  return {
    last_updated: new Date().toISOString(),
    verdict:      philliesBetter ? "We're so back" : "It's so over",
    phillies_better: philliesBetter,
    scores: {
      phillies: { offense: phillies.offenseScore, pitching: phillies.pitchingScore, total: phiTotal },
      dodgers:  { offense: dodgers.offenseScore,  pitching: dodgers.pitchingScore,  total: ladTotal },
    },
    category_wins: { phillies: philliesCategoryWins, dodgers: dodgersCategoryWins },
    comparisons,
    team_stats: { phillies, dodgers },
  };
}

module.exports = { scrapeAndCompare };
