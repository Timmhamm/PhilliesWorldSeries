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
// Fetch MLB-wide team stats — find best team for each stat
// ---------------------------------------------------------------------------

async function fetchMLBLeaders(season) {
  const [hJson, pJson] = await Promise.all([
    fetch(`${MLB_API}/teams/stats?season=${season}&group=hitting&stats=season&sportId=1`).then(r => r.json()),
    fetch(`${MLB_API}/teams/stats?season=${season}&group=pitching&stats=season&sportId=1`).then(r => r.json()),
  ]);

  const hSplits = hJson.stats?.[0]?.splits || [];
  const pSplits = pJson.stats?.[0]?.splits || [];

  // Require at least 10 teams with 3+ games for the data to be meaningful
  const meaningful = hSplits.filter(s => (s.stat?.gamesPlayed || 0) >= 3).length >= 10;

  const shortName = name => name?.split(' ').pop() ?? name;

  // Rate stats — use raw value directly
  const bestFrom = (splits, field, higherIsBetter) => {
    const valid = splits.filter(s => s.stat?.[field] != null && !isNaN(parseFloat(s.stat[field])));
    if (!valid.length) return null;
    valid.sort((a, b) => higherIsBetter
      ? parseFloat(b.stat[field]) - parseFloat(a.stat[field])
      : parseFloat(a.stat[field]) - parseFloat(b.stat[field]));
    return { value: parseFloat(valid[0].stat[field]), team: shortName(valid[0].team.name) };
  };

  // Counting stats — project each team to 162-game pace before comparing
  const bestFromPaced = (splits, field, higherIsBetter) => {
    const valid = splits
      .map(s => {
        const raw = parseFloat(s.stat?.[field]);
        const gp  = parseFloat(s.stat?.gamesPlayed) || 0;
        if (isNaN(raw) || gp === 0) return null;
        return { paced: (raw / gp) * 162, team: shortName(s.team.name) };
      })
      .filter(Boolean);
    if (!valid.length) return null;
    valid.sort((a, b) => higherIsBetter ? b.paced - a.paced : a.paced - b.paced);
    return { value: valid[0].paced, team: valid[0].team };
  };

  return {
    meaningful,
    batting: {
      OPS: bestFrom(hSplits,      'ops',         true),
      OBP: bestFrom(hSplits,      'obp',         true),
      SLG: bestFrom(hSplits,      'slg',         true),
      BA:  bestFrom(hSplits,      'avg',         true),
      HR:  bestFromPaced(hSplits, 'homeRuns',    true),
      BB:  bestFromPaced(hSplits, 'baseOnBalls', true),
      SO:  bestFromPaced(hSplits, 'strikeOuts',  false),
      SB:  bestFromPaced(hSplits, 'stolenBases', true),
    },
    pitching: {
      ERA:  bestFrom(pSplits, 'era',                false),
      WHIP: bestFrom(pSplits, 'whip',               false),
      SO9:  bestFrom(pSplits, 'strikeoutsPer9Inn',  true),
      BB9:  bestFrom(pSplits, 'walksPer9Inn',       false),
      HR9:  bestFrom(pSplits, 'homeRunsPer9',       false),
      SOBB: bestFrom(pSplits, 'strikeoutWalkRatio', true),
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
    name: split.player?.fullName || '?', PA: pa, GP: gp,
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
    name: split.player?.fullName || '?', IP: ip,
    ERA:  toFloat(s.era),
    WHIP: toFloat(s.whip),
    SO9:  toFloat(s.strikeoutsPer9Inn),
    BB9:  toFloat(s.walksPer9Inn),
    HR9:  toFloat(s.homeRunsPer9),
    SOBB: toFloat(s.strikeoutWalkRatio),
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
// Team score composites
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
      HR: sumStat(batters, 'HR'), BB: sumStat(batters, 'BB'),
      SO: sumStat(batters, 'SO'), SB: sumStat(batters, 'SB'),
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
// Category comparison — PHI vs LAD, PHI vs MLB Best '25, PHI vs MLB Best '26
// ---------------------------------------------------------------------------

function compareStats(phillies, dodgers, leaders25, leaders26) {
  const rows = [];

  const add = (label, phiVal, ladVal, best25, best26, higherIsBetter, fmt) => {
    if (phiVal == null || ladVal == null) return;
    const f = fmt || (v => v?.toFixed(3) ?? 'N/A');

    // Determine which entity has the best value across all four
    const candidates = [
      { key: 'PHI',    val: phiVal },
      { key: 'LAD',    val: ladVal },
      { key: "MLB '25", val: best25?.value ?? null },
      { key: "MLB '26", val: best26?.value ?? null },
    ].filter(c => c.val != null);

    const best = candidates.reduce((a, b) =>
      (higherIsBetter ? b.val > a.val : b.val < a.val) ? b : a
    );

    const better26 = best26?.value != null
      ? (higherIsBetter ? phiVal > best26.value : phiVal < best26.value)
      : null;

    rows.push({
      label,
      phillies:           f(phiVal),
      dodgers:            f(ladVal),
      mlbBest25:          best25 ? f(best25.value) : 'N/A',
      mlbBestTeam25:      best25?.team ?? '',
      mlbBest26:          best26 ? f(best26.value) : 'TBD',
      mlbBestTeam26:      best26?.team ?? '',
      edge:               best.key,
      phillies_better:    higherIsBetter ? phiVal > ladVal : phiVal < ladVal,
      phillies_better_26: better26,
    });
  };

  const fmt3 = v => v?.toFixed(3) ?? 'N/A';
  const fmt1 = v => v?.toFixed(1)  ?? 'N/A';
  const fmtI = v => v != null ? Math.round(v).toString() : 'N/A';

  const b25 = leaders25?.batting  || {};
  const p25 = leaders25?.pitching || {};
  const b26 = leaders26?.batting  || {};
  const p26 = leaders26?.pitching || {};

  add('OPS',              phillies.batting.OPS,  dodgers.batting.OPS,  b25.OPS,  b26.OPS,  true,  fmt3);
  add('OBP',              phillies.batting.OBP,  dodgers.batting.OBP,  b25.OBP,  b26.OBP,  true,  fmt3);
  add('SLG',              phillies.batting.SLG,  dodgers.batting.SLG,  b25.SLG,  b26.SLG,  true,  fmt3);
  add('Batting Avg',      phillies.batting.BA,   dodgers.batting.BA,   b25.BA,   b26.BA,   true,  fmt3);
  add('HR (162-gm pace)', phillies.batting.HR,   dodgers.batting.HR,   b25.HR,   b26.HR,   true,  fmtI);
  add('BB (162-gm pace)', phillies.batting.BB,   dodgers.batting.BB,   b25.BB,   b26.BB,   true,  fmtI);
  add('SO (162-gm pace)', phillies.batting.SO,   dodgers.batting.SO,   b25.SO,   b26.SO,   false, fmtI);
  add('SB (162-gm pace)', phillies.batting.SB,   dodgers.batting.SB,   b25.SB,   b26.SB,   true,  fmtI);
  add('ERA',              phillies.pitching.ERA,  dodgers.pitching.ERA,  p25.ERA,  p26.ERA,  false, fmt3);
  add('WHIP',             phillies.pitching.WHIP, dodgers.pitching.WHIP, p25.WHIP, p26.WHIP, false, fmt3);
  add('SO/9',             phillies.pitching.SO9,  dodgers.pitching.SO9,  p25.SO9,  p26.SO9,  true,  fmt1);
  add('BB/9',             phillies.pitching.BB9,  dodgers.pitching.BB9,  p25.BB9,  p26.BB9,  false, fmt1);
  add('HR/9',             phillies.pitching.HR9,  dodgers.pitching.HR9,  p25.HR9,  p26.HR9,  false, fmt1);
  add('SO/BB',            phillies.pitching.SOBB, dodgers.pitching.SOBB, p25.SOBB, p26.SOBB, true,  fmt3);

  return rows;
}

// ---------------------------------------------------------------------------
// World Series Prediction Model
// Based on historical WS stat correlations — pitching (50pts) + offense (35pts)
// ---------------------------------------------------------------------------

function pitchingWsScore(p) {
  if (!p) return 0;
  let score = 0;

  // ERA: max 18pts (lower is better)
  if      (p.ERA <= 3.20) score += 18;
  else if (p.ERA <= 3.50) score += 16;
  else if (p.ERA <= 3.80) score += 14;
  else if (p.ERA <= 4.00) score += 11;
  else if (p.ERA <= 4.50) score += 6;
  else if (p.ERA <= 5.00) score += 2;

  // WHIP: max 14pts (lower is better)
  if      (p.WHIP <= 1.05) score += 14;
  else if (p.WHIP <= 1.10) score += 12;
  else if (p.WHIP <= 1.18) score += 10;
  else if (p.WHIP <= 1.25) score += 7;
  else if (p.WHIP <= 1.35) score += 4;
  else if (p.WHIP <= 1.45) score += 1;

  // SO/BB: max 10pts (higher is better)
  if      (p.SOBB >= 4.0) score += 10;
  else if (p.SOBB >= 3.5) score += 8;
  else if (p.SOBB >= 3.0) score += 6;
  else if (p.SOBB >= 2.5) score += 4;
  else if (p.SOBB >= 2.0) score += 2;

  // BB/9: max 5pts (lower is better)
  if      (p.BB9 <= 2.5) score += 5;
  else if (p.BB9 <= 3.0) score += 4;
  else if (p.BB9 <= 3.5) score += 3;
  else if (p.BB9 <= 4.0) score += 1;

  // HR/9: max 3pts (lower is better)
  if      (p.HR9 <= 0.9) score += 3;
  else if (p.HR9 <= 1.1) score += 2;
  else if (p.HR9 <= 1.3) score += 1;

  return score; // max 50
}

function offenseWsScore(b) {
  if (!b) return 0;
  let score = 0;

  // OPS: max 15pts (higher is better)
  if      (b.OPS >= 0.820) score += 15;
  else if (b.OPS >= 0.800) score += 13;
  else if (b.OPS >= 0.780) score += 11;
  else if (b.OPS >= 0.760) score += 8;
  else if (b.OPS >= 0.740) score += 5;
  else if (b.OPS >= 0.720) score += 2;

  // OBP: max 12pts (higher is better)
  if      (b.OBP >= 0.355) score += 12;
  else if (b.OBP >= 0.345) score += 10;
  else if (b.OBP >= 0.330) score += 8;
  else if (b.OBP >= 0.320) score += 5;
  else if (b.OBP >= 0.310) score += 3;
  else if (b.OBP >= 0.300) score += 1;

  // SLG: max 5pts (higher is better)
  if      (b.SLG >= 0.470) score += 5;
  else if (b.SLG >= 0.450) score += 4;
  else if (b.SLG >= 0.430) score += 3;
  else if (b.SLG >= 0.410) score += 2;
  else if (b.SLG >= 0.390) score += 1;

  // BA: max 3pts (higher is better)
  if      (b.BA >= 0.280) score += 3;
  else if (b.BA >= 0.265) score += 2;
  else if (b.BA >= 0.250) score += 1;

  return score; // max 35
}

function wsConfidenceMultiplier(dataSource, gamesPlayed) {
  if (dataSource === 'spring') return 0.15;
  if (gamesPlayed >= 120) return 1.00;
  if (gamesPlayed >= 82)  return 0.90;
  if (gamesPlayed >= 60)  return 0.80;
  if (gamesPlayed >= 40)  return 0.70;
  if (gamesPlayed >= 25)  return 0.60;
  if (gamesPlayed >= 15)  return 0.45;
  if (gamesPlayed >= 5)   return 0.30;
  return 0.15;
}

function wsLabel(score) {
  if (score >= 70) return 'Elite WS contender';
  if (score >= 55) return 'Strong WS contender';
  if (score >= 42) return 'Legit contender';
  if (score >= 30) return 'Bubble team';
  return 'Long shot';
}

function calcWsScore(team, dataSource, gamesPlayed) {
  const pitching   = pitchingWsScore(team.pitching);
  const offense    = offenseWsScore(team.batting);
  const raw        = pitching + offense; // max 85
  const confidence = wsConfidenceMultiplier(dataSource, gamesPlayed);
  return { raw, pitching, offense, confidence, adjusted: raw * confidence, label: wsLabel(raw) };
}

// ---------------------------------------------------------------------------
// Verdict — category wins + WS prediction score
// ---------------------------------------------------------------------------

function calcVerdict(comparisons, phiWs, ladWs, phiComposite, ladComposite) {
  // Category edge counts (unchanged — used for the score pills)
  const phi = comparisons.filter(c => c.edge === 'PHI').length;
  const lad = comparisons.filter(c => c.edge === 'LAD').length;
  const m25 = comparisons.filter(c => c.edge === "MLB '25").length;
  const m26 = comparisons.filter(c => c.edge === "MLB '26").length;

  // Primary verdict: WS score comparison (PHI raw vs LAD raw)
  // If scores are equal or close, fall back to category count, then composite
  const scoreDiff = phiWs.raw - ladWs.raw;
  let philliesBetter;
  if (Math.abs(scoreDiff) >= 3) {
    philliesBetter = scoreDiff > 0;
  } else {
    // Tiebreaker 1: category wins vs LAD
    const maxOpp = Math.max(lad, m25, m26);
    philliesBetter = phi !== maxOpp ? phi > maxOpp : phiComposite > ladComposite;
  }

  return {
    philliesBetter,
    category_wins: { phillies: phi, dodgers: lad, mlb_25: m25, mlb_26: m26 },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function scrapeAndCompare() {
  console.log(`[${new Date().toISOString()}] Fetching MLB API stats...`);

  const [philliesRaw, dodgersRaw, leaders25, leaders26] = await Promise.all([
    fetchTeamStats(PHILLIES_ID, 2026),
    fetchTeamStats(DODGERS_ID,  2025),
    fetchMLBLeaders(2025),
    fetchMLBLeaders(2026),
  ]);

  const phillies = buildTeamSummary(philliesRaw.batting, philliesRaw.pitching, philliesRaw.battingSource, philliesRaw.pitchingSource);
  const dodgers  = buildTeamSummary(dodgersRaw.batting,  dodgersRaw.pitching,  dodgersRaw.battingSource,  dodgersRaw.pitchingSource);

  const comparisons = compareStats(phillies, dodgers, leaders25, leaders26);

  const phiComposite = (phillies.offenseScore || 0) + (phillies.pitchingScore || 0);
  const ladComposite = (dodgers.offenseScore  || 0) + (dodgers.pitchingScore  || 0);

  // Games played for confidence multiplier — max across all PHI batters
  const phiGamesPlayed = Math.max(0, ...philliesRaw.batting.map(s => s.stat?.gamesPlayed || 0));
  const ladGamesPlayed = Math.max(0, ...dodgersRaw.batting.map(s => s.stat?.gamesPlayed || 0));

  const phiWs = calcWsScore(phillies, philliesRaw.battingSource, phiGamesPlayed);
  const ladWs = calcWsScore(dodgers,  dodgersRaw.battingSource,  ladGamesPlayed);

  const { philliesBetter, category_wins } = calcVerdict(
    comparisons, phiWs, ladWs, phiComposite, ladComposite
  );

  // Count how many categories each entity "wins" (has the best value)
  const edge_counts = {
    'PHI':     comparisons.filter(c => c.edge === 'PHI').length,
    'LAD':     comparisons.filter(c => c.edge === 'LAD').length,
    'MLB_25':  comparisons.filter(c => c.edge === "MLB '25").length,
    'MLB_26':  comparisons.filter(c => c.edge === "MLB '26").length,
  };

  return {
    last_updated:         new Date().toISOString(),
    verdict:              philliesBetter ? "We're so back" : "It's so over",
    phillies_better:      philliesBetter,
    phillies_data_source: philliesRaw.battingSource,
    leaders_26_active:    leaders26.meaningful,
    total_categories:     comparisons.length,
    scores: {
      phillies: { offense: phillies.offenseScore, pitching: phillies.pitchingScore, total: phiComposite },
      dodgers:  { offense: dodgers.offenseScore,  pitching: dodgers.pitchingScore,  total: ladComposite },
    },
    ws_scores: {
      phillies: phiWs,
      dodgers:  ladWs,
    },
    category_wins,
    edge_counts,
    comparisons,
    team_stats: { phillies, dodgers },
  };
}

module.exports = { scrapeAndCompare };
