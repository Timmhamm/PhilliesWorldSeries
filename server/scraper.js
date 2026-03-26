const fetch = require('node-fetch');

const MLB_API     = 'https://statsapi.mlb.com/api/v1';
const PHILLIES_ID = 143;
const DODGERS_ID  = 119;

const FULL_SEASON_GAMES = 162;
const FULL_SEASON_PA    = 700;  // approx full-time PA
const MIN_PA_SPRING     = 20;
const MIN_IP_SPRING     = 5;
const MIN_PA_REGULAR    = 50;
const MIN_IP_REGULAR    = 10;
const MIN_GAMES_REGULAR = 5;   // threshold to consider regular season "started"

// ---------------------------------------------------------------------------
// Fetch — tries regular season first, falls back to spring training
// ---------------------------------------------------------------------------

async function fetchGroup(teamId, season, group) {
  const base = `${MLB_API}/stats?stats=season&group=${group}&season=${season}&sportId=1&teamId=${teamId}&playerPool=ALL&limit=100`;

  const rRes  = await fetch(`${base}&gameType=R`);
  const rJson = await rRes.json();
  const rSplits = rJson.stats?.[0]?.splits || [];

  const hasRegularData = rSplits.some(s => (s.stat?.gamesPlayed || 0) >= MIN_GAMES_REGULAR);
  if (hasRegularData) return { source: 'regular', splits: rSplits };

  const sRes  = await fetch(`${base}&gameType=S`);
  const sJson = await sRes.json();
  return { source: 'spring', splits: sJson.stats?.[0]?.splits || [] };
}

async function fetchTeamStats(teamId, season) {
  const [hitting, pitching] = await Promise.all([
    fetchGroup(teamId, season, 'hitting'),
    fetchGroup(teamId, season, 'pitching'),
  ]);
  return {
    batting:       hitting.splits,
    pitching:      pitching.splits,
    battingSource: hitting.source,
    pitchingSource: pitching.source,
  };
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

const toFloat = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const toInt   = v => { const n = parseInt(v);   return isNaN(n) ? null : n; };

// Convert MLB's "16.2" IP notation (16 innings + 2 outs = 16.667 IP) to decimal
function parseIP(ip) {
  const [whole, frac = '0'] = String(ip || '0').split('.');
  return parseInt(whole) + parseInt(frac) / 3;
}

// Project a counting stat to full-season pace
function toPace(stat, played, full = FULL_SEASON_GAMES) {
  if (!played || played === 0) return null;
  return (stat / played) * full;
}

function parseBatter(split, source) {
  const s   = split.stat || {};
  const gp  = toInt(s.gamesPlayed) || 0;
  const pa  = toInt(s.plateAppearances) || 0;
  const minPA = source === 'spring' ? MIN_PA_SPRING : MIN_PA_REGULAR;

  if (pa < minPA) return null;

  return {
    name: split.player?.fullName || '?',
    PA:   pa,
    GP:   gp,
    // Rate stats — directly comparable regardless of sample size
    BA:   toFloat(s.avg),
    OBP:  toFloat(s.obp),
    SLG:  toFloat(s.slg),
    OPS:  toFloat(s.ops),
    // Counting stats — projected to 162-game pace for fair comparison
    HR:   toPace(toInt(s.homeRuns)   || 0, gp),
    BB:   toPace(toInt(s.baseOnBalls)|| 0, gp),
    SO:   toPace(toInt(s.strikeOuts) || 0, gp),
    SB:   toPace(toInt(s.stolenBases)|| 0, gp),
    // Raw counts kept for display
    HR_raw: toInt(s.homeRuns)    || 0,
    BB_raw: toInt(s.baseOnBalls) || 0,
    SO_raw: toInt(s.strikeOuts)  || 0,
    SB_raw: toInt(s.stolenBases) || 0,
  };
}

function parsePitcher(split, source) {
  const s   = split.stat || {};
  const ip  = parseIP(s.inningsPitched);
  const minIP = source === 'spring' ? MIN_IP_SPRING : MIN_IP_REGULAR;

  if (ip < minIP) return null;

  return {
    name: split.player?.fullName || '?',
    IP:   ip,
    // Rate stats from API (already calculated per 9 innings)
    ERA:  toFloat(s.era)                || toFloat(s.earnedRunAverage),
    WHIP: toFloat(s.whip),
    SO9:  toFloat(s.strikeoutsPer9Inn)  || toFloat(s.strikeoutsPerNine),
    BB9:  toFloat(s.walksPer9Inn)       || toFloat(s.walksPerNine),
    HR9:  toFloat(s.homeRunsPer9)       || toFloat(s.homeRunsPerNine),
    SOBB: toFloat(s.strikeoutWalkRatio),
  };
}

// ---------------------------------------------------------------------------
// Weighted averaging
// ---------------------------------------------------------------------------

function weightedAvg(players, statKey, weightKey) {
  const q = players.filter(p => p[statKey] !== null && p[statKey] !== undefined && p[weightKey] > 0);
  const totalW = q.reduce((sum, p) => sum + p[weightKey], 0);
  if (!totalW) return null;
  return q.reduce((sum, p) => sum + p[statKey] * p[weightKey], 0) / totalW;
}

function sumStat(players, statKey) {
  return players.reduce((sum, p) => sum + (p[statKey] || 0), 0);
}

// ---------------------------------------------------------------------------
// Team score (composite)
// ---------------------------------------------------------------------------

function offenseScore(batters) {
  if (!batters.length) return null;
  const OPS = weightedAvg(batters, 'OPS', 'PA');
  const OBP = weightedAvg(batters, 'OBP', 'PA');
  const SLG = weightedAvg(batters, 'SLG', 'PA');
  if (OPS === null) return null;
  return OPS * 0.50 + OBP * 0.30 + SLG * 0.20;
}

function pitchingScore(pitchers) {
  if (!pitchers.length) return null;
  const ERA  = weightedAvg(pitchers, 'ERA',  'IP');
  const WHIP = weightedAvg(pitchers, 'WHIP', 'IP');
  const SOBB = weightedAvg(pitchers, 'SOBB', 'IP');
  const BB9  = weightedAvg(pitchers, 'BB9',  'IP');
  const HR9  = weightedAvg(pitchers, 'HR9',  'IP');
  if (!ERA || !WHIP) return null;
  return (1 / ERA)   * 0.30 +
         (1 / WHIP)  * 0.25 +
         (SOBB || 0) * 0.20 +
         (BB9 ? 1 / BB9 : 0) * 0.15 +
         (HR9 ? 1 / HR9 : 0) * 0.10;
}

// ---------------------------------------------------------------------------
// Build team summary
// ---------------------------------------------------------------------------

function buildTeamSummary(rawBatting, rawPitching, battingSource, pitchingSource) {
  const batters  = rawBatting.map(s => parseBatter(s, battingSource)).filter(Boolean);
  const pitchers = rawPitching.map(s => parsePitcher(s, pitchingSource)).filter(Boolean);

  return {
    batting: {
      OPS: weightedAvg(batters, 'OPS', 'PA'),
      OBP: weightedAvg(batters, 'OBP', 'PA'),
      SLG: weightedAvg(batters, 'SLG', 'PA'),
      BA:  weightedAvg(batters, 'BA',  'PA'),
      // Projected counting stats (per 162 games)
      HR:  sumStat(batters, 'HR'),
      BB:  sumStat(batters, 'BB'),
      SO:  sumStat(batters, 'SO'),
      SB:  sumStat(batters, 'SB'),
    },
    pitching: {
      ERA:  weightedAvg(pitchers, 'ERA',  'IP'),
      WHIP: weightedAvg(pitchers, 'WHIP', 'IP'),
      SO9:  weightedAvg(pitchers, 'SO9',  'IP'),
      BB9:  weightedAvg(pitchers, 'BB9',  'IP'),
      HR9:  weightedAvg(pitchers, 'HR9',  'IP'),
      SOBB: weightedAvg(pitchers, 'SOBB', 'IP'),
    },
    offenseScore:   offenseScore(batters),
    pitchingScore:  pitchingScore(pitchers),
    dataSource: {
      batting:  battingSource,
      pitching: pitchingSource,
    },
    playerCount: { batters: batters.length, pitchers: pitchers.length },
  };
}

// ---------------------------------------------------------------------------
// Category comparison
// ---------------------------------------------------------------------------

function compareStats(phillies, dodgers) {
  const rows = [];
  const add = (label, phiVal, ladVal, higherIsBetter, fmt = v => v?.toFixed(3) ?? 'N/A') => {
    if (phiVal == null || ladVal == null) return;
    rows.push({
      label,
      phillies: fmt(phiVal),
      dodgers:  fmt(ladVal),
      phillies_better: higherIsBetter ? phiVal > ladVal : phiVal < ladVal,
    });
  };
  const fmt3 = v => v?.toFixed(3) ?? 'N/A';
  const fmt1 = v => v?.toFixed(1) ?? 'N/A';
  const fmtI = v => v != null ? Math.round(v).toString() : 'N/A';

  // Batting — rate stats first (directly comparable), then pace-projected counts
  add('OPS',                phillies.batting.OPS,  dodgers.batting.OPS,  true,  fmt3);
  add('OBP',                phillies.batting.OBP,  dodgers.batting.OBP,  true,  fmt3);
  add('SLG',                phillies.batting.SLG,  dodgers.batting.SLG,  true,  fmt3);
  add('Batting Avg',        phillies.batting.BA,   dodgers.batting.BA,   true,  fmt3);
  add('HR (162-gm pace)',   phillies.batting.HR,   dodgers.batting.HR,   true,  fmtI);
  add('BB (162-gm pace)',   phillies.batting.BB,   dodgers.batting.BB,   true,  fmtI);
  add('SO (162-gm pace)',   phillies.batting.SO,   dodgers.batting.SO,   false, fmtI);
  add('SB (162-gm pace)',   phillies.batting.SB,   dodgers.batting.SB,   true,  fmtI);

  // Pitching — all rate stats, already per-9-innings
  add('ERA',                phillies.pitching.ERA,  dodgers.pitching.ERA,  false, fmt3);
  add('WHIP',               phillies.pitching.WHIP, dodgers.pitching.WHIP, false, fmt3);
  add('SO/9',               phillies.pitching.SO9,  dodgers.pitching.SO9,  true,  fmt1);
  add('BB/9',               phillies.pitching.BB9,  dodgers.pitching.BB9,  false, fmt1);
  add('HR/9',               phillies.pitching.HR9,  dodgers.pitching.HR9,  false, fmt1);
  add('SO/BB',              phillies.pitching.SOBB, dodgers.pitching.SOBB, true,  fmt3);

  return rows;
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

  console.log(`[${new Date().toISOString()}] Phillies source: ${philliesRaw.battingSource} | Dodgers source: ${dodgersRaw.battingSource}`);

  const phillies = buildTeamSummary(philliesRaw.batting,  philliesRaw.pitching,  philliesRaw.battingSource,  philliesRaw.pitchingSource);
  const dodgers  = buildTeamSummary(dodgersRaw.batting,   dodgersRaw.pitching,   dodgersRaw.battingSource,   dodgersRaw.pitchingSource);

  const comparisons = compareStats(phillies, dodgers);

  const phiTotal   = (phillies.offenseScore || 0) + (phillies.pitchingScore || 0);
  const ladTotal   = (dodgers.offenseScore  || 0) + (dodgers.pitchingScore  || 0);
  const phiCatWins = comparisons.filter(c => c.phillies_better).length;
  const ladCatWins = comparisons.filter(c => !c.phillies_better).length;
  const philliesBetter = phiTotal !== ladTotal ? phiTotal > ladTotal : phiCatWins >= ladCatWins;

  return {
    last_updated:    new Date().toISOString(),
    verdict:         philliesBetter ? "We're so back" : "It's so over",
    phillies_better: philliesBetter,
    phillies_data_source: philliesRaw.battingSource,  // 'spring' or 'regular'
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
