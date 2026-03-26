const fetch = require('node-fetch');

// MLB Stats API — no auth required, official data
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const PHILLIES_ID = 143;
const DODGERS_ID  = 119;

// ---------------------------------------------------------------------------
// Fetch player stats from MLB API
// ---------------------------------------------------------------------------

async function fetchTeamStats(teamId, season) {
  const [hittingRes, pitchingRes] = await Promise.all([
    fetch(`${MLB_API}/stats?stats=season&group=hitting&season=${season}&sportId=1&teamId=${teamId}&limit=100`),
    fetch(`${MLB_API}/stats?stats=season&group=pitching&season=${season}&sportId=1&teamId=${teamId}&limit=100`),
  ]);

  if (!hittingRes.ok)  throw new Error(`MLB API hitting fetch failed: ${hittingRes.status}`);
  if (!pitchingRes.ok) throw new Error(`MLB API pitching fetch failed: ${pitchingRes.status}`);

  const hittingJson  = await hittingRes.json();
  const pitchingJson = await pitchingRes.json();

  return {
    batting:  hittingJson.stats?.[0]?.splits  || [],
    pitching: pitchingJson.stats?.[0]?.splits || [],
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const toFloat = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const toInt   = v => { const n = parseInt(v);   return isNaN(n) ? null : n; };

function parseBatter(split) {
  const s = split.stat || {};
  return {
    name: split.player?.fullName || '?',
    PA:   toInt(s.plateAppearances) || 0,
    HR:   toInt(s.homeRuns)         || 0,
    BB:   toInt(s.baseOnBalls)      || 0,
    SO:   toInt(s.strikeOuts)       || 0,
    SB:   toInt(s.stolenBases)      || 0,
    BA:   toFloat(s.avg),
    OBP:  toFloat(s.obp),
    SLG:  toFloat(s.slg),
    OPS:  toFloat(s.ops),
  };
}

function parsePitcher(split) {
  const s = split.stat || {};
  // IP is stored as "62.1" (innings.outs) — convert to decimal
  const ipRaw = s.inningsPitched || '0';
  const [inn, outs = '0'] = String(ipRaw).split('.');
  const ip = parseInt(inn) + parseInt(outs) / 3;

  const so  = toInt(s.strikeOuts)   || 0;
  const bb  = toInt(s.baseOnBalls)  || 0;
  const hr  = toInt(s.homeRuns)     || 0;
  const h   = toInt(s.hits)         || 0;
  const er  = toInt(s.earnedRuns)   || 0;

  const era  = ip > 0 ? (er / ip) * 9  : null;
  const whip = ip > 0 ? (bb + h) / ip  : null;
  const so9  = ip > 0 ? (so / ip) * 9  : null;
  const bb9  = ip > 0 ? (bb / ip) * 9  : null;
  const hr9  = ip > 0 ? (hr / ip) * 9  : null;
  const sobb = bb > 0 ? so / bb : so > 0 ? so : null;

  return {
    name: split.player?.fullName || '?',
    IP:   ip,
    ERA:  era  ?? toFloat(s.era),
    WHIP: whip ?? toFloat(s.whip),
    SO9:  so9,
    BB9:  bb9,
    HR9:  hr9,
    SOBB: sobb,
  };
}

// ---------------------------------------------------------------------------
// Weighted averaging
// ---------------------------------------------------------------------------

function weightedAvg(players, statKey, weightKey) {
  const q = players.filter(p => p[statKey] !== null && p[weightKey] > 0);
  const totalWeight = q.reduce((sum, p) => sum + p[weightKey], 0);
  if (totalWeight === 0) return null;
  return q.reduce((sum, p) => sum + p[statKey] * p[weightKey], 0) / totalWeight;
}

function sumStat(players, statKey) {
  return players.reduce((sum, p) => sum + (p[statKey] || 0), 0);
}

// ---------------------------------------------------------------------------
// Team score calculation
// ---------------------------------------------------------------------------

function offenseScore(batters) {
  const q = batters.filter(p => p.PA >= 50);
  if (!q.length) return null;
  const OPS = weightedAvg(q, 'OPS', 'PA');
  const OBP = weightedAvg(q, 'OBP', 'PA');
  const SLG = weightedAvg(q, 'SLG', 'PA');
  if (OPS === null) return null;
  return OPS * 0.50 + OBP * 0.30 + SLG * 0.20;
}

function pitchingScore(pitchers) {
  const q = pitchers.filter(p => p.IP >= 10);
  if (!q.length) return null;
  const ERA  = weightedAvg(q, 'ERA',  'IP');
  const WHIP = weightedAvg(q, 'WHIP', 'IP');
  const SOBB = weightedAvg(q, 'SOBB', 'IP');
  const BB9  = weightedAvg(q, 'BB9',  'IP');
  const HR9  = weightedAvg(q, 'HR9',  'IP');
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
  const qB = batters.filter(p => p.PA >= 50);
  const qP = pitchers.filter(p => p.IP >= 10);

  return {
    batting: {
      OPS: weightedAvg(qB, 'OPS', 'PA'),
      OBP: weightedAvg(qB, 'OBP', 'PA'),
      SLG: weightedAvg(qB, 'SLG', 'PA'),
      BA:  weightedAvg(qB, 'BA',  'PA'),
      HR:  sumStat(batters, 'HR'),
      BB:  sumStat(batters, 'BB'),
      SO:  sumStat(batters, 'SO'),
      SB:  sumStat(batters, 'SB'),
    },
    pitching: {
      ERA:  weightedAvg(qP, 'ERA',  'IP'),
      WHIP: weightedAvg(qP, 'WHIP', 'IP'),
      SO9:  weightedAvg(qP, 'SO9',  'IP'),
      BB9:  weightedAvg(qP, 'BB9',  'IP'),
      HR9:  weightedAvg(qP, 'HR9',  'IP'),
      SOBB: weightedAvg(qP, 'SOBB', 'IP'),
    },
    offenseScore:  offenseScore(batters),
    pitchingScore: pitchingScore(pitchers),
    playerCount: { batters: qB.length, pitchers: qP.length },
  };
}

// ---------------------------------------------------------------------------
// Category-by-category comparison
// ---------------------------------------------------------------------------

function compareStats(phillies, dodgers) {
  const comparisons = [];
  const add = (label, phiVal, ladVal, higherIsBetter, fmt = v => v?.toFixed(3) ?? 'N/A') => {
    if (phiVal == null || ladVal == null) return;
    comparisons.push({
      label,
      phillies: fmt(phiVal),
      dodgers:  fmt(ladVal),
      phillies_better: higherIsBetter ? phiVal > ladVal : phiVal < ladVal,
    });
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
// Main export
// ---------------------------------------------------------------------------

async function scrapeAndCompare() {
  console.log(`[${new Date().toISOString()}] Fetching MLB API stats...`);

  const [philliesRaw, dodgersRaw] = await Promise.all([
    fetchTeamStats(PHILLIES_ID, 2026),
    fetchTeamStats(DODGERS_ID,  2025),
  ]);

  console.log(`[${new Date().toISOString()}] Fetch complete.`);

  const phillies = buildTeamSummary(philliesRaw.batting, philliesRaw.pitching);
  const dodgers  = buildTeamSummary(dodgersRaw.batting,  dodgersRaw.pitching);
  const comparisons = compareStats(phillies, dodgers);

  const phiTotal = (phillies.offenseScore || 0) + (phillies.pitchingScore || 0);
  const ladTotal = (dodgers.offenseScore  || 0) + (dodgers.pitchingScore  || 0);
  const phiCatWins = comparisons.filter(c => c.phillies_better).length;
  const ladCatWins = comparisons.filter(c => !c.phillies_better).length;
  const philliesBetter = phiTotal !== ladTotal ? phiTotal > ladTotal : phiCatWins >= ladCatWins;

  return {
    last_updated:    new Date().toISOString(),
    verdict:         philliesBetter ? "We're so back" : "It's so over",
    phillies_better: philliesBetter,
    scores: {
      phillies: { offense: phillies.offenseScore, pitching: phillies.pitchingScore, total: phiTotal },
      dodgers:  { offense: dodgers.offenseScore,  pitching: dodgers.pitchingScore,  total: ladTotal },
    },
    category_wins: { phillies: phiCatWins, dodgers: ladCatWins },
    comparisons,
    team_stats: { phillies, dodgers },
  };
}

module.exports = { scrapeAndCompare };
