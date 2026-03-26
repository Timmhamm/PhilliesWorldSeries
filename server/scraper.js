const fetch = require('node-fetch');

const MLB_API     = 'https://statsapi.mlb.com/api/v1';
const PHILLIES_ID = 143;
const DODGERS_ID  = 119;

const MIN_PA_SPRING     = 20;
const MIN_IP_SPRING     = 5;
const MIN_PA_REGULAR    = 50;
const MIN_IP_REGULAR    = 10;
const MIN_GAMES_REGULAR = 5;

// ---------------------------------------------------------------------------
// Fetch player stats — tries regular season, falls back to spring training
// ---------------------------------------------------------------------------

async function fetchGroup(teamId, season, group) {
  const base = `${MLB_API}/stats?stats=season&group=${group}&season=${season}&sportId=1&teamId=${teamId}&playerPool=ALL&limit=100`;

  const rJson = await fetch(`${base}&gameType=R`).then(r => r.json());
  const rSplits = rJson.stats?.[0]?.splits || [];

  if (rSplits.some(s => (s.stat?.gamesPlayed || 0) >= MIN_GAMES_REGULAR)) {
    return { source: 'regular', splits: rSplits };
  }

  const sJson = await fetch(`${base}&gameType=S`).then(r => r.json());
  return { source: 'spring', splits: sJson.stats?.[0]?.splits || [] };
}

async function fetchTeamStats(teamId, season) {
  const [hitting, pitching] = await Promise.all([
    fetchGroup(teamId, season, 'hitting'),
    fetchGroup(teamId, season, 'pitching'),
  ]);
  return {
    batting: hitting.splits, pitching: pitching.splits,
    battingSource: hitting.source, pitchingSource: pitching.source,
  };
}

// ---------------------------------------------------------------------------
// Fetch MLB-wide team stats to find the best team for each category
// ---------------------------------------------------------------------------

async function fetchMLBLeaders() {
  const [hJson, pJson] = await Promise.all([
    fetch(`${MLB_API}/teams/stats?season=2025&group=hitting&stats=season&sportId=1`).then(r => r.json()),
    fetch(`${MLB_API}/teams/stats?season=2025&group=pitching&stats=season&sportId=1`).then(r => r.json()),
  ]);

  const hSplits = hJson.stats?.[0]?.splits || [];
  const pSplits = pJson.stats?.[0]?.splits || [];

  // Short team name — last word of full name (e.g. "New York Yankees" → "Yankees")
  const shortName = name => name?.split(' ').pop() ?? name;

  const bestFrom = (splits, field, higherIsBetter) => {
    const valid = splits.filter(s => s.stat?.[field] != null && !isNaN(parseFloat(s.stat[field])));
    if (!valid.length) return null;
    valid.sort((a, b) => higherIsBetter
      ? parseFloat(b.stat[field]) - parseFloat(a.stat[field])
      : parseFloat(a.stat[field]) - parseFloat(b.stat[field]));
    return { value: parseFloat(valid[0].stat[field]), team: shortName(valid[0].team.name) };
  };

  return {
    batting: {
      OPS: bestFrom(hSplits, 'ops',          true),
      OBP: bestFrom(hSplits, 'obp',          true),
      SLG: bestFrom(hSplits, 'slg',          true),
      BA:  bestFrom(hSplits, 'avg',          true),
      HR:  bestFrom(hSplits, 'homeRuns',     true),
      BB:  bestFrom(hSplits, 'baseOnBalls',  true),
      SO:  bestFrom(hSplits, 'strikeOuts',   false),
      SB:  bestFrom(hSplits, 'stolenBases',  true),
    },
    pitching: {
      ERA:  bestFrom(pSplits, 'era',                 false),
      WHIP: bestFrom(pSplits, 'whip',                false),
      SO9:  bestFrom(pSplits, 'strikeoutsPer9Inn',   true),
      BB9:  bestFrom(pSplits, 'walksPer9Inn',        false),
      HR9:  bestFrom(pSplits, 'homeRunsPer9',        false),
      SOBB: bestFrom(pSplits, 'strikeoutWalkRatio',  true),
    },
  };
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

const toFloat = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const toInt   = v => { const n = parseInt(v);   return isNaN(n) ? null : n; };

function parseIP(ip) {
  const [whole, frac = '0'] = String(ip || '0').split('.');
  return parseInt(whole) + parseInt(frac) / 3;
}

function toPace(stat, played, full = 162) {
  if (!played) return null;
  return (stat / played) * full;
}

function parseBatter(split, source) {
  const s  = split.stat || {};
  const pa = toInt(s.plateAppearances) || 0;
  const gp = toInt(s.gamesPlayed) || 0;
  if (pa < (source === 'spring' ? MIN_PA_SPRING : MIN_PA_REGULAR)) return null;

  return {
    name: split.player?.fullName || '?',
    PA: pa, GP: gp,
    BA: toFloat(s.avg), OBP: toFloat(s.obp), SLG: toFloat(s.slg), OPS: toFloat(s.ops),
    HR: toPace(toInt(s.homeRuns)    || 0, gp),
    BB: toPace(toInt(s.baseOnBalls) || 0, gp),
    SO: toPace(toInt(s.strikeOuts)  || 0, gp),
    SB: toPace(toInt(s.stolenBases) || 0, gp),
  };
}

function parsePitcher(split, source) {
  const s  = split.stat || {};
  const ip = parseIP(s.inningsPitched);
  if (ip < (source === 'spring' ? MIN_IP_SPRING : MIN_IP_REGULAR)) return null;

  return {
    name: split.player?.fullName || '?',
    IP:   ip,
    ERA:  toFloat(s.era)                || null,
    WHIP: toFloat(s.whip)               || null,
    SO9:  toFloat(s.strikeoutsPer9Inn)  || null,
    BB9:  toFloat(s.walksPer9Inn)       || null,
    HR9:  toFloat(s.homeRunsPer9)       || null,
    SOBB: toFloat(s.strikeoutWalkRatio) || null,
  };
}

// ---------------------------------------------------------------------------
// Weighted averaging
// ---------------------------------------------------------------------------

function weightedAvg(players, statKey, weightKey) {
  const q = players.filter(p => p[statKey] != null && p[weightKey] > 0);
  const w = q.reduce((s, p) => s + p[weightKey], 0);
  if (!w) return null;
  return q.reduce((s, p) => s + p[statKey] * p[weightKey], 0) / w;
}

function sumStat(players, k) {
  return players.reduce((s, p) => s + (p[k] || 0), 0);
}

// ---------------------------------------------------------------------------
// Team summary
// ---------------------------------------------------------------------------

function offenseScore(batters) {
  if (!batters.length) return null;
  const OPS = weightedAvg(batters, 'OPS', 'PA');
  const OBP = weightedAvg(batters, 'OBP', 'PA');
  const SLG = weightedAvg(batters, 'SLG', 'PA');
  if (OPS == null) return null;
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

function buildTeamSummary(rawBatting, rawPitching, battingSource, pitchingSource) {
  const batters  = rawBatting.map(s => parseBatter(s, battingSource)).filter(Boolean);
  const pitchers = rawPitching.map(s => parsePitcher(s, pitchingSource)).filter(Boolean);
  return {
    batting: {
      OPS: weightedAvg(batters, 'OPS', 'PA'), OBP: weightedAvg(batters, 'OBP', 'PA'),
      SLG: weightedAvg(batters, 'SLG', 'PA'), BA:  weightedAvg(batters, 'BA',  'PA'),
      HR:  sumStat(batters, 'HR'), BB: sumStat(batters, 'BB'),
      SO:  sumStat(batters, 'SO'), SB: sumStat(batters, 'SB'),
    },
    pitching: {
      ERA:  weightedAvg(pitchers, 'ERA',  'IP'), WHIP: weightedAvg(pitchers, 'WHIP', 'IP'),
      SO9:  weightedAvg(pitchers, 'SO9',  'IP'), BB9:  weightedAvg(pitchers, 'BB9',  'IP'),
      HR9:  weightedAvg(pitchers, 'HR9',  'IP'), SOBB: weightedAvg(pitchers, 'SOBB', 'IP'),
    },
    offenseScore:  offenseScore(batters),
    pitchingScore: pitchingScore(pitchers),
    dataSource: { batting: battingSource, pitching: pitchingSource },
    playerCount: { batters: batters.length, pitchers: pitchers.length },
  };
}

// ---------------------------------------------------------------------------
// Category comparison — now includes MLB leader for each stat
// ---------------------------------------------------------------------------

function compareStats(phillies, dodgers, leaders) {
  const rows = [];

  const add = (label, phiVal, ladVal, mlbLeader, higherIsBetter, fmt) => {
    if (phiVal == null || ladVal == null) return;
    const f = fmt || (v => v?.toFixed(3) ?? 'N/A');
    rows.push({
      label,
      phillies:        f(phiVal),
      dodgers:         f(ladVal),
      mlbBest:         mlbLeader ? f(mlbLeader.value) : 'N/A',
      mlbBestTeam:     mlbLeader?.team ?? '',
      phillies_better: higherIsBetter ? phiVal > ladVal : phiVal < ladVal,
    });
  };

  const fmt3 = v => v?.toFixed(3) ?? 'N/A';
  const fmt1 = v => v?.toFixed(1)  ?? 'N/A';
  const fmtI = v => v != null ? Math.round(v).toString() : 'N/A';

  const b  = leaders?.batting  || {};
  const p  = leaders?.pitching || {};

  add('OPS',              phillies.batting.OPS,  dodgers.batting.OPS,  b.OPS,  true,  fmt3);
  add('OBP',              phillies.batting.OBP,  dodgers.batting.OBP,  b.OBP,  true,  fmt3);
  add('SLG',              phillies.batting.SLG,  dodgers.batting.SLG,  b.SLG,  true,  fmt3);
  add('Batting Avg',      phillies.batting.BA,   dodgers.batting.BA,   b.BA,   true,  fmt3);
  add('HR (162-gm pace)', phillies.batting.HR,   dodgers.batting.HR,   b.HR,   true,  fmtI);
  add('BB (162-gm pace)', phillies.batting.BB,   dodgers.batting.BB,   b.BB,   true,  fmtI);
  add('SO (162-gm pace)', phillies.batting.SO,   dodgers.batting.SO,   b.SO,   false, fmtI);
  add('SB (162-gm pace)', phillies.batting.SB,   dodgers.batting.SB,   b.SB,   true,  fmtI);
  add('ERA',              phillies.pitching.ERA,  dodgers.pitching.ERA,  p.ERA,  false, fmt3);
  add('WHIP',             phillies.pitching.WHIP, dodgers.pitching.WHIP, p.WHIP, false, fmt3);
  add('SO/9',             phillies.pitching.SO9,  dodgers.pitching.SO9,  p.SO9,  true,  fmt1);
  add('BB/9',             phillies.pitching.BB9,  dodgers.pitching.BB9,  p.BB9,  false, fmt1);
  add('HR/9',             phillies.pitching.HR9,  dodgers.pitching.HR9,  p.HR9,  false, fmt1);
  add('SO/BB',            phillies.pitching.SOBB, dodgers.pitching.SOBB, p.SOBB, true,  fmt3);

  return rows;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function scrapeAndCompare() {
  console.log(`[${new Date().toISOString()}] Fetching MLB API stats...`);

  const [philliesRaw, dodgersRaw, leaders] = await Promise.all([
    fetchTeamStats(PHILLIES_ID, 2026),
    fetchTeamStats(DODGERS_ID,  2025),
    fetchMLBLeaders(),
  ]);

  const phillies = buildTeamSummary(philliesRaw.batting, philliesRaw.pitching, philliesRaw.battingSource, philliesRaw.pitchingSource);
  const dodgers  = buildTeamSummary(dodgersRaw.batting,  dodgersRaw.pitching,  dodgersRaw.battingSource,  dodgersRaw.pitchingSource);

  const comparisons = compareStats(phillies, dodgers, leaders);

  const phiTotal   = (phillies.offenseScore || 0) + (phillies.pitchingScore || 0);
  const ladTotal   = (dodgers.offenseScore  || 0) + (dodgers.pitchingScore  || 0);
  const phiCatWins = comparisons.filter(c => c.phillies_better).length;
  const ladCatWins = comparisons.filter(c => !c.phillies_better).length;
  const philliesBetter = phiTotal !== ladTotal ? phiTotal > ladTotal : phiCatWins >= ladCatWins;

  return {
    last_updated:         new Date().toISOString(),
    verdict:              philliesBetter ? "We're so back" : "It's so over",
    phillies_better:      philliesBetter,
    phillies_data_source: philliesRaw.battingSource,
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
