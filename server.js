// 甲子園トーナメント予想アプリ — サーバ本体
// 起動: npm start → http://localhost:3310
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 3310;
const MULT_MIN = 1.0;
const MULT_MAX = 3.0;          // 試合オッズの上限
const CHAMPION_MULT_MAX = 5.0; // 優勝オッズの上限
const START_BALANCE = 1000;    // 初期持ち点
const MIN_STAKE = 10;          // 試合ベットの下限（上限なし・持ち点の範囲内）
const CHAMPION_BASE = 100;     // 優勝ベットの原則額（払戻はこの額 × オッズ）
const CHAMPION_LATE_FEE = 100; // レイト参加費: 1ラウンド消化ごとの参加コスト増分
const RELIEF_AMOUNT = 100;     // 救済チップ
const EXTRA_REFUND_RATE = 0.5; // 延長決着: 勝者側ベットの半金返還率（敗者側・同点扱い分は没収）

// 管理者パスワード（config.json・git管理外。初回起動時に生成されるので変更推奨）
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ admin_password: 'koshien-admin' }, null, 2));
  console.log('config.json を生成しました（管理者パスワード初期値: koshien-admin。変更推奨）');
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 大会種別テンプレート: round(1始まり) → ラベル・基礎pt（基礎ptはステーク上限の基準）
const TEMPLATES = {
  koshien: {
    kindLabel: '全国大会',
    bonus: 100,
    rounds: [
      { label: '1回戦', base: 10 }, { label: '2回戦', base: 15 }, { label: '3回戦', base: 20 },
      { label: '準々決勝', base: 30 }, { label: '準決勝', base: 40 }, { label: '決勝', base: 50 },
    ],
  },
  regional: {
    kindLabel: '地方大会',
    bonus: 50,
    rounds: [
      { label: '1回戦', base: 5 }, { label: '2回戦', base: 5 }, { label: '3回戦', base: 8 },
      { label: '4回戦', base: 8 }, { label: '5回戦', base: 10 }, { label: '準々決勝', base: 12 },
      { label: '準決勝', base: 16 }, { label: '決勝', base: 20 },
    ],
  },
};

// ---- DB オープン（旧スキーマは退避して作り直し）------------------------------
const DB_PATH = path.join(__dirname, 'koshien.db');
let db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
{
  const matchCols = db.prepare('PRAGMA table_info(matches)').all();
  const predCols = db.prepare('PRAGMA table_info(predictions)').all();
  const legacy =
    (matchCols.length > 0 && !matchCols.some((c) => c.name === 'tournament_id')) ||
    (predCols.length > 0 && !predCols.some((c) => c.name === 'stake'));
  if (legacy) {
    db.close();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(__dirname, `koshien.legacy-${stamp}.db`);
    fs.renameSync(DB_PATH, backup);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(DB_PATH + ext)) fs.renameSync(DB_PATH + ext, backup + ext);
    }
    console.log(`旧スキーマのDBを ${path.basename(backup)} に退避しました`);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  relief_count INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT                 -- NULL = 未設定（初回ログイン時に設定される）
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                -- koshien | regional
  rounds_json TEXT NOT NULL,         -- [{label, base}, ...] round は 1 始まりの添字
  champion_bonus INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  name TEXT NOT NULL,
  prefecture TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  round INTEGER NOT NULL,
  day TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  game_no INTEGER NOT NULL,
  team1_id INTEGER NOT NULL REFERENCES teams(id),
  team2_id INTEGER NOT NULL REFERENCES teams(id),
  winner_id INTEGER REFERENCES teams(id),
  score1 INTEGER,
  score2 INTEGER,
  scheduled_at TEXT,                 -- 'YYYY-MM-DDTHH:mm'（ローカル時刻）
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | finished | void（不成立＝全額返還）
  extra_innings INTEGER NOT NULL DEFAULT 0   -- 1 = 延長決着（勝者側ベット半金返還・他は没収）
);
CREATE TABLE IF NOT EXISTS predictions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  predicted_winner_id INTEGER NOT NULL REFERENCES teams(id),
  stake INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE TABLE IF NOT EXISTS champion_picks (
  user_id INTEGER NOT NULL REFERENCES users(id),
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  stake INTEGER NOT NULL,            -- 支払った参加コスト（原則100＋レイト参加費）
  picked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tournament_id)
);
CREATE TABLE IF NOT EXISTS ai_predictions (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  confidence INTEGER NOT NULL,       -- 優勢度 50〜95 (%)
  comment TEXT,
  updated_at TEXT NOT NULL
);
`);

// 既存DBへの追加カラム移行（データ保持のため ALTER で行う）
{
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (userCols.length && !userCols.some((c) => c.name === 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  const matchCols2 = db.prepare('PRAGMA table_info(matches)').all();
  if (matchCols2.length && !matchCols2.some((c) => c.name === 'extra_innings')) {
    db.exec('ALTER TABLE matches ADD COLUMN extra_innings INTEGER NOT NULL DEFAULT 0');
  }
}

// ---- 認証（名前＋パスワード。トークンはメモリ保持＝サーバ再起動で要再ログイン）----
const tokens = new Map(); // token → { user_id } | { admin: true }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split('$');
  if (!salt || !h) return false;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32));
}
function issueToken(payload) {
  const t = crypto.randomUUID();
  tokens.set(t, payload);
  return t;
}
function auth(req) {
  return tokens.get(req.get('x-token') || '') || null;
}
// ベット系: 通常ユーザーは自分自身のみ、管理者は body.user_id で代理操作可
function actorUserId(req, res) {
  const session = auth(req);
  if (!session) { res.status(401).json({ error: 'ログインしてください' }); return null; }
  if (session.admin) {
    const uid = Number(req.body.user_id);
    if (!uid) { res.status(400).json({ error: '管理者操作は user_id の指定が必要です' }); return null; }
    return uid;
  }
  return session.user_id;
}
function requireAdmin(req, res) {
  const session = auth(req);
  if (!session?.admin) { res.status(403).json({ error: '管理者ログインが必要です' }); return false; }
  return true;
}

// ---- ダミーデータ投入（tournaments が空のときだけ）----------------------------
// 学校名はすべて架空。本大会の組み合わせ抽選後に実データへ差し替える（plan.md M4）。
function insertTournament(name, kind) {
  const t = TEMPLATES[kind];
  return db.prepare(
    'INSERT INTO tournaments (name, kind, rounds_json, champion_bonus) VALUES (?, ?, ?, ?)'
  ).run(name, kind, JSON.stringify(t.rounds), t.bonus).lastInsertRowid;
}

// 実データシード（2026-07-24 時点。出典: 高野連公式 代表校一覧・ベースボールチャンネル各大会ページ）
// - 甲子園代表は決定済みの7校のみ。以降の代表は管理タブ「学校の追加」で随時追加する。
// - 各地方大会の決勝カードは準決勝の結果確定後に管理タブ「試合の追加」で登録する。
function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM tournaments').get().c > 0) return;

  const insTeam = db.prepare('INSERT INTO teams (tournament_id, name, prefecture) VALUES (?, ?, ?)');
  const insMatch = db.prepare(`INSERT INTO matches
    (tournament_id, round, day, game_no, team1_id, team2_id, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const SEMI = 7; // regional テンプレートの準決勝

  // 全国大会（甲子園）: 決定済み代表のみ。組み合わせ抽選（8月上旬）まで試合なし＝優勝予想の先行ベット期間
  const koshienId = insertTournament('全国大会（甲子園）', 'koshien');
  [
    ['白樺学園', '北北海道'], ['札幌日大', '南北海道'], ['青森山田', '青森'],
    ['横手', '秋田'], ['東海大甲府', '山梨'], ['日南学園', '宮崎'], ['沖縄尚学', '沖縄'],
  ].forEach(([name, pref]) => insTeam.run(koshienId, name, pref));

  // 東東京大会: 準決勝 7/25（開始時刻未確認のため締切は当日8:00）、決勝 7/27
  const eastId = insertTournament('東東京大会', 'regional');
  const east = ['目黒日大', '関東第一', '二松学舎大付', '帝京']
    .map((name) => insTeam.run(eastId, name, '東東京').lastInsertRowid);
  insMatch.run(eastId, SEMI, '2026-07-25', 1, east[0], east[1], null);
  insMatch.run(eastId, SEMI, '2026-07-25', 2, east[2], east[3], null);

  // 西東京大会: 準決勝 7/24（開始時刻未確認のため締切は当日8:00）、決勝 7/26 神宮
  const westId = insertTournament('西東京大会', 'regional');
  const west = ['日大三', '創価', '八王子実践', '明大八王子']
    .map((name) => insTeam.run(westId, name, '西東京').lastInsertRowid);
  insMatch.run(westId, SEMI, '2026-07-24', 1, west[0], west[1], null);
  insMatch.run(westId, SEMI, '2026-07-24', 2, west[2], west[3], null);

  // 神奈川大会: 準決勝 7/24 9:00 / 11:30 横浜スタジアム、決勝 7/26
  const kanagawaId = insertTournament('神奈川大会', 'regional');
  const kanagawa = ['横浜', '慶應義塾', '鎌倉学園', '桐光学園']
    .map((name) => insTeam.run(kanagawaId, name, '神奈川').lastInsertRowid);
  insMatch.run(kanagawaId, SEMI, '2026-07-24', 1, kanagawa[0], kanagawa[1], '2026-07-24T09:00');
  insMatch.run(kanagawaId, SEMI, '2026-07-24', 2, kanagawa[2], kanagawa[3], '2026-07-24T11:30');

  // 大阪大会: 準々決勝 7/24（開始時刻未確認）、準決勝 7/26、決勝 7/28
  const QF = 6;
  const osakaId = insertTournament('大阪大会', 'regional');
  const osaka = ['履正社', '近大付', '関大北陽', '金光大阪', '箕面学園', '大商大', '東海大大阪仰星', '生野']
    .map((name) => insTeam.run(osakaId, name, '大阪').lastInsertRowid);
  insMatch.run(osakaId, QF, '2026-07-24', 1, osaka[0], osaka[1], null);
  insMatch.run(osakaId, QF, '2026-07-24', 2, osaka[2], osaka[3], null);
  insMatch.run(osakaId, QF, '2026-07-24', 3, osaka[4], osaka[5], null);
  insMatch.run(osakaId, QF, '2026-07-24', 4, osaka[6], osaka[7], null);

  console.log('実データを投入しました（甲子園代表7校・東東京/西東京/神奈川/大阪）');
}
seed();

// ---- 共通ロジック -----------------------------------------------------------
function roundsOf(tournament) {
  return JSON.parse(tournament.rounds_json);
}
function roundInfo(tournament, round) {
  return roundsOf(tournament)[round - 1] || { label: `第${round}ラウンド`, base: 10 };
}
function deadlineOf(match) {
  return new Date(match.scheduled_at || `${match.day}T08:00`);
}
function isLocked(match, now = new Date()) {
  return now >= deadlineOf(match) || match.status === 'finished';
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
// その試合のプール（ステーク合計）と、各チーム勝利時の倍率（ポイント量加重パリミュチュエル）
function distributionOf(matchId, team1Id, team2Id) {
  const rows = db.prepare(
    `SELECT predicted_winner_id AS t, SUM(stake) AS pool, COUNT(*) AS c
     FROM predictions WHERE match_id = ? GROUP BY t`
  ).all(matchId);
  const r1 = rows.find((r) => r.t === team1Id);
  const r2 = rows.find((r) => r.t === team2Id);
  const p1 = r1?.pool ?? 0, p2 = r2?.pool ?? 0;
  const total = p1 + p2;
  const multOf = (pool) =>
    pool === 0 ? null : Math.round(clamp(total / pool, MULT_MIN, MULT_MAX) * 100) / 100;
  return { p1, p2, c1: r1?.c ?? 0, c2: r2?.c ?? 0, total, mult1: multOf(p1), mult2: multOf(p2) };
}
// 大会ごとの優勝予想の分布とオッズ（原則額は全員同じなので人数比）
function championDistribution(tournamentId) {
  const rows = db.prepare(
    `SELECT team_id, COUNT(*) AS c FROM champion_picks
     WHERE tournament_id = ? GROUP BY team_id`
  ).all(tournamentId);
  const total = rows.reduce((s, r) => s + r.c, 0);
  const odds = {};
  for (const r of rows) {
    odds[r.team_id] = Math.round(clamp(total / r.c, MULT_MIN, CHAMPION_MULT_MAX) * 100) / 100;
  }
  return { total, odds };
}
// 消化済みラウンド数（結果が1つ以上確定しているラウンドの数）
function progressedRounds(tournamentId) {
  return db.prepare(
    "SELECT COUNT(DISTINCT round) AS c FROM matches WHERE tournament_id = ? AND status = 'finished'"
  ).get(tournamentId).c;
}
// 優勝ベットの現在の参加コスト。レイト参加ほど高い（払戻は原則額 × オッズのままなので実質オッズが下がる）
function championCostNow(tournamentId) {
  return CHAMPION_BASE + CHAMPION_LATE_FEE * progressedRounds(tournamentId);
}
// 大会の優勝校 = 最終ラウンド（決勝）の勝者
function championTeamId(tournament) {
  const finalRound = roundsOf(tournament).length;
  const final = db.prepare(
    "SELECT winner_id FROM matches WHERE tournament_id = ? AND round = ? AND status = 'finished'"
  ).get(tournament.id, finalRound);
  return final ? final.winner_id : null;
}
// 優勝予想のロック時刻 = 決勝の締切（レイト参加可。決勝が未登録なら受付継続）
function championLockAt(tournament) {
  const finalRound = roundsOf(tournament).length;
  const final = db.prepare(
    'SELECT day, scheduled_at FROM matches WHERE tournament_id = ? AND round = ? LIMIT 1'
  ).get(tournament.id, finalRound);
  return final ? deadlineOf(final) : null;
}

// 全ユーザーの持ち点・確定収支・的中数をベット履歴から導出する。
// 残高カラムは持たない: 結果の修正（勝者上書き）でも再計算だけで整合するため。
function computeStats() {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const tournaments = db.prepare('SELECT * FROM tournaments').all();
  const tMap = new Map(tournaments.map((t) => [t.id, t]));
  const stats = new Map(users.map((u) => [u.id, {
    user_id: u.id, name: u.name, relief_count: u.relief_count,
    balance: START_BALANCE + u.relief_count * RELIEF_AMOUNT,
    profit: 0, hits: 0, predicted: 0, champion_hits: 0, champion_total: 0,
  }]));

  const matches = db.prepare('SELECT * FROM matches').all();
  const mMap = new Map(matches.map((m) => [m.id, m]));
  const distCache = new Map();
  const distFor = (m) => {
    if (!distCache.has(m.id)) distCache.set(m.id, distributionOf(m.id, m.team1_id, m.team2_id));
    return distCache.get(m.id);
  };

  for (const p of db.prepare('SELECT * FROM predictions').all()) {
    const s = stats.get(p.user_id);
    const m = mMap.get(p.match_id);
    if (!s || !m) continue;
    if (m.status === 'void') continue; // 不成立（不戦勝など）＝ステーク全額返還扱い
    s.balance -= p.stake;
    if (m.status !== 'finished') continue;
    s.predicted++;
    if (m.extra_innings) {
      // 9回で決着せず＝同点扱いで没収。ただし延長勝者側ベットは半金返還
      if (p.predicted_winner_id === m.winner_id) {
        const refund = Math.round(p.stake * EXTRA_REFUND_RATE);
        s.hits++;
        s.balance += refund;
        s.profit += refund - p.stake;
      } else {
        s.profit -= p.stake;
      }
      continue;
    }
    const d = distFor(m);
    const mult = m.winner_id === m.team1_id ? d.mult1 : d.mult2;
    if (p.predicted_winner_id === m.winner_id && mult != null) {
      const payout = Math.round(p.stake * mult);
      s.hits++;
      s.balance += payout;
      s.profit += payout - p.stake;
    } else {
      s.profit -= p.stake;
    }
  }

  for (const p of db.prepare('SELECT * FROM champion_picks').all()) {
    const s = stats.get(p.user_id);
    const t = tMap.get(p.tournament_id);
    if (!s || !t) continue;
    s.champion_total++;
    s.balance -= p.stake;
    const champId = championTeamId(t);
    if (champId == null) continue; // 大会未決着 → ステークは in play のまま
    const mult = championDistribution(t.id).odds[champId] ?? null;
    if (p.team_id === champId && mult != null) {
      // 払戻は原則額ベース。レイト参加費（stake − 原則額）は返ってこない
      const payout = Math.round(CHAMPION_BASE * mult);
      s.champion_hits++;
      s.balance += payout;
      s.profit += payout - p.stake;
    } else {
      s.profit -= p.stake;
    }
  }
  return stats;
}

function computeRanking() {
  const rows = [...computeStats().values()];
  rows.sort((a, b) => b.profit - a.profit || b.hits - a.hits);
  // 同点は同順位
  let rank = 0, prevProfit = null, prevHits = null;
  rows.forEach((r, i) => {
    if (r.profit !== prevProfit || r.hits !== prevHits) {
      rank = i + 1; prevProfit = r.profit; prevHits = r.hits;
    }
    r.rank = rank;
  });
  return rows;
}

function balanceOf(userId) {
  return computeStats().get(userId)?.balance ?? null;
}

// ---- SSE（ベットが入った瞬間にオッズを配信）-----------------------------------
const sseClients = new Set();
function broadcast() {
  for (const client of sseClients) client.write('data: update\n\n');
}

// ---- API --------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// 画面表示に必要な全データを1回で返す
app.get('/api/bootstrap', (req, res) => {
  const session = auth(req);
  // 自分のベットは自分（または管理者の代理照会）だけが見られる
  const userId = session
    ? (session.admin ? Number(req.query.user_id) || null : session.user_id)
    : null;
  const now = new Date();
  const users = db.prepare('SELECT id, name FROM users ORDER BY id').all();
  const teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
  const tournaments = db.prepare('SELECT * FROM tournaments ORDER BY id').all();
  const teamMap = new Map(teams.map((t) => [t.id, t]));
  const tMap = new Map(tournaments.map((t) => [t.id, t]));
  const myPreds = userId
    ? new Map(db.prepare('SELECT match_id, predicted_winner_id, stake FROM predictions WHERE user_id = ?')
        .all(userId).map((p) => [p.match_id, p]))
    : new Map();

  const aiMap = new Map(db.prepare('SELECT * FROM ai_predictions').all().map((a) => [a.match_id, a]));
  const matches = db.prepare(
    "SELECT * FROM matches ORDER BY day, COALESCE(scheduled_at, day || 'T08:00'), tournament_id, game_no"
  ).all().map((m) => {
    const t = tMap.get(m.tournament_id);
    const info = roundInfo(t, m.round);
    const locked = isLocked(m, now);
    const mine = myPreds.get(m.id);
    const out = {
      id: m.id, tournament_id: m.tournament_id,
      round: m.round, round_label: info.label,
      min_stake: MIN_STAKE,
      day: m.day, game_no: m.game_no, scheduled_at: m.scheduled_at,
      deadline: deadlineOf(m).toISOString(), locked,
      status: m.status, winner_id: m.winner_id, score1: m.score1, score2: m.score2,
      extra_innings: !!m.extra_innings,
      team1: teamMap.get(m.team1_id), team2: teamMap.get(m.team2_id),
      my_pick: mine?.predicted_winner_id ?? null,
      my_stake: mine?.stake ?? null,
      ai: aiMap.has(m.id)
        ? { team_id: aiMap.get(m.id).team_id, confidence: aiMap.get(m.id).confidence,
            comment: aiMap.get(m.id).comment }
        : null,
    };
    // オッズは常時表示（変動オッズ。締切時点のプールで確定）。プール内訳は締切後のみ公開
    const d = distributionOf(m.id, m.team1_id, m.team2_id);
    out.odds = { mult1: d.mult1, mult2: d.mult2, fixed: locked };
    if (locked) {
      out.dist = d;
      if (m.status === 'finished' && out.my_pick != null) {
        if (m.extra_innings) {
          out.my_payout = out.my_pick === m.winner_id
            ? Math.round(out.my_stake * EXTRA_REFUND_RATE) : 0;
        } else {
          const mult = m.winner_id === m.team1_id ? d.mult1 : d.mult2;
          out.my_payout = out.my_pick === m.winner_id && mult != null
            ? Math.round(out.my_stake * mult) : 0;
        }
      }
    }
    return out;
  });

  const champions = tournaments.map((t) => {
    const lockAt = championLockAt(t);
    const champId = championTeamId(t);
    const mine = userId
      ? db.prepare('SELECT team_id, stake FROM champion_picks WHERE user_id = ? AND tournament_id = ?')
          .get(userId, t.id)
      : null;
    return {
      tournament_id: t.id,
      lock_at: lockAt ? lockAt.toISOString() : null,
      locked: (lockAt ? now >= lockAt : false) || champId != null,
      champion_team_id: champId,
      my_pick: mine?.team_id ?? null,
      my_stake: mine?.stake ?? null,
      base: CHAMPION_BASE,
      current_cost: championCostNow(t.id),
      mult_max: CHAMPION_MULT_MAX,
      odds: championDistribution(t.id).odds,
    };
  });

  const stats = userId ? computeStats().get(userId) : null;

  res.json({
    now: now.toISOString(),
    start_balance: START_BALANCE,
    min_stake: MIN_STAKE,
    relief_amount: RELIEF_AMOUNT,
    my_balance: stats?.balance ?? null,
    me: session
      ? (session.admin
          ? { admin: true }
          : { admin: false, user_id: session.user_id,
              name: users.find((u) => u.id === session.user_id)?.name ?? '' })
      : null,
    users, teams,
    tournaments: tournaments.map((t) => ({
      id: t.id, name: t.name, kind: t.kind,
      kind_label: TEMPLATES[t.kind]?.kindLabel ?? t.kind,
      rounds: roundsOf(t), champion_bonus: t.champion_bonus,
    })),
    matches,
    ranking: computeRanking(),
    champions,
  });
});

// 新規参加（名前＋パスワード）。登録と同時にログイン扱い
app.post('/api/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'ニックネームを入力してください' });
  if (password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
  try {
    const info = db.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)')
      .run(name, hashPassword(password));
    res.json({ id: info.lastInsertRowid, name, token: issueToken({ user_id: Number(info.lastInsertRowid) }) });
  } catch {
    res.status(409).json({ error: 'そのニックネームは既に使われています' });
  }
});

app.post('/api/login', (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (user.password_hash == null) {
    // パスワード導入前の既存ユーザー: 初回ログインで入力したパスワードを設定
    if (password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  } else if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'パスワードが違います' });
  }
  res.json({ id: user.id, name: user.name, token: issueToken({ user_id: user.id }) });
});

app.post('/api/admin/login', (req, res) => {
  if (String(req.body.password || '') !== CONFIG.admin_password) {
    return res.status(401).json({ error: '管理者パスワードが違います' });
  }
  res.json({ token: issueToken({ admin: true }) });
});

function validateStake(stake, balancePlusRefund) {
  if (!Number.isInteger(stake)) return 'ベット額は整数で指定してください';
  if (stake < MIN_STAKE) return `ベット額は最低 ${MIN_STAKE}pt です`;
  if (stake > balancePlusRefund) return `持ち点が足りません（利用可能 ${balancePlusRefund}pt）`;
  return null;
}

app.post('/api/predictions', (req, res) => {
  const user_id = actorUserId(req, res);
  if (user_id == null) return;
  const { match_id, team_id, stake } = req.body;
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: '試合が見つかりません' });
  if (isLocked(match)) return res.status(400).json({ error: '締切を過ぎています' });
  if (team_id !== match.team1_id && team_id !== match.team2_id) {
    return res.status(400).json({ error: 'この試合の出場校ではありません' });
  }
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }
  const existing = db.prepare(
    'SELECT stake FROM predictions WHERE user_id = ? AND match_id = ?'
  ).get(user_id, match_id);
  const available = balanceOf(user_id) + (existing?.stake ?? 0); // 張り替えは旧ステーク返却扱い
  const err = validateStake(stake, available);
  if (err) return res.status(400).json({ error: err });

  db.prepare(`INSERT INTO predictions (user_id, match_id, predicted_winner_id, stake, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET predicted_winner_id = excluded.predicted_winner_id,
      stake = excluded.stake, created_at = excluded.created_at`)
    .run(user_id, match_id, team_id, stake, new Date().toISOString());
  broadcast(); // ベットが入った瞬間に全クライアントへオッズ反映
  res.json({ ok: true });
});

app.post('/api/champion', (req, res) => {
  const user_id = actorUserId(req, res);
  if (user_id == null) return;
  const { tournament_id, team_id } = req.body;
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournament_id);
  if (!tournament) return res.status(404).json({ error: '大会が見つかりません' });
  if (championTeamId(tournament) != null) {
    return res.status(400).json({ error: 'この大会は決着済みです' });
  }
  const lockAt = championLockAt(tournament);
  if (lockAt && new Date() >= lockAt) {
    return res.status(400).json({ error: '優勝予想は決勝開始後のため変更できません' });
  }
  const team = db.prepare('SELECT tournament_id FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'チームが見つかりません' });
  if (team.tournament_id !== tournament_id) {
    return res.status(400).json({ error: 'この大会に出場していない学校です' });
  }
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }
  // 参加コストはサーバ側で決定（原則100＋レイト参加費）。張り替えは旧コスト返却→現在コストで再徴収
  const cost = championCostNow(tournament_id);
  const existing = db.prepare(
    'SELECT stake FROM champion_picks WHERE user_id = ? AND tournament_id = ?'
  ).get(user_id, tournament_id);
  const available = balanceOf(user_id) + (existing?.stake ?? 0);
  if (cost > available) {
    return res.status(400).json({ error: `持ち点が足りません（参加コスト ${cost}pt / 利用可能 ${available}pt）` });
  }

  db.prepare(`INSERT INTO champion_picks (user_id, tournament_id, team_id, stake, picked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tournament_id) DO UPDATE SET team_id = excluded.team_id,
      stake = excluded.stake, picked_at = excluded.picked_at`)
    .run(user_id, tournament_id, team_id, cost, new Date().toISOString());
  broadcast();
  res.json({ ok: true, cost });
});

// ベット取消（締切前のみ・全額返却）
app.post('/api/predictions/cancel', (req, res) => {
  const user_id = actorUserId(req, res);
  if (user_id == null) return;
  const { match_id } = req.body;
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: '試合が見つかりません' });
  if (isLocked(match)) return res.status(400).json({ error: '締切後は取消できません' });
  const del = db.prepare('DELETE FROM predictions WHERE user_id = ? AND match_id = ?')
    .run(user_id, match_id);
  if (!del.changes) return res.status(404).json({ error: 'ベットが見つかりません' });
  broadcast();
  res.json({ ok: true });
});

// 救済チップ: 持ち点がベット下限を下回ったときだけ +100pt（回数はランキングで公開）
app.post('/api/relief', (req, res) => {
  const user_id = actorUserId(req, res);
  if (user_id == null) return;
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }
  const balance = balanceOf(user_id);
  if (balance >= MIN_STAKE) {
    return res.status(400).json({ error: `救済チップは持ち点 ${MIN_STAKE}pt 未満のときだけ受け取れます` });
  }
  db.prepare('UPDATE users SET relief_count = relief_count + 1 WHERE id = ?').run(user_id);
  broadcast();
  res.json({ ok: true, balance: balance + RELIEF_AMOUNT });
});

// ---- 管理系 -------------------------------------------------------------------
app.post('/api/admin/tournaments', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, kind } = req.body;
  if (!TEMPLATES[kind]) return res.status(400).json({ error: '大会種別が不正です' });
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: '大会名を入力してください' });
  try {
    res.json({ id: insertTournament(trimmed, kind) });
    broadcast();
  } catch {
    res.status(409).json({ error: 'その大会名は既に存在します' });
  }
});

app.post('/api/admin/teams', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tournament_id } = req.body;
  const name = String(req.body.name || '').trim();
  const prefecture = String(req.body.prefecture || '').trim();
  if (!db.prepare('SELECT id FROM tournaments WHERE id = ?').get(tournament_id)) {
    return res.status(404).json({ error: '大会が見つかりません' });
  }
  if (!name || !prefecture) return res.status(400).json({ error: '校名と都道府県を入力してください' });
  const info = db.prepare('INSERT INTO teams (tournament_id, name, prefecture) VALUES (?, ?, ?)')
    .run(tournament_id, name, prefecture);
  broadcast();
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/admin/matches', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tournament_id, round, day, game_no, team1_id, team2_id, time } = req.body;
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournament_id);
  if (!tournament) return res.status(404).json({ error: '大会が見つかりません' });
  if (!roundsOf(tournament)[round - 1]) return res.status(400).json({ error: 'ラウンドが不正です' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return res.status(400).json({ error: '日付が不正です' });
  if (team1_id === team2_id) return res.status(400).json({ error: '同一チーム同士は指定できません' });
  for (const tid of [team1_id, team2_id]) {
    const team = db.prepare('SELECT tournament_id FROM teams WHERE id = ?').get(tid);
    if (!team || team.tournament_id !== tournament_id) {
      return res.status(400).json({ error: 'この大会に登録されていない学校が含まれています' });
    }
  }
  const scheduledAt = time ? `${day}T${time}` : null;
  const info = db.prepare(`INSERT INTO matches
    (tournament_id, round, day, game_no, team1_id, team2_id, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(tournament_id, round, day, game_no || 1, team1_id, team2_id, scheduledAt);
  broadcast();
  res.json({ id: info.lastInsertRowid });
});

// AI予想の登録（Claude が試合情報を分析して投入する。表示専用でプールには参加しない）
app.post('/api/admin/ai', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { match_id, team_id, confidence, comment } = req.body;
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: '試合が見つかりません' });
  if (team_id !== match.team1_id && team_id !== match.team2_id) {
    return res.status(400).json({ error: 'この試合の出場校ではありません' });
  }
  const conf = Number(confidence);
  if (!Number.isInteger(conf) || conf < 50 || conf > 95) {
    return res.status(400).json({ error: '優勢度は50〜95の整数で指定してください' });
  }
  db.prepare(`INSERT INTO ai_predictions (match_id, team_id, confidence, comment, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET team_id = excluded.team_id,
      confidence = excluded.confidence, comment = excluded.comment, updated_at = excluded.updated_at`)
    .run(match_id, team_id, conf, comment || null, new Date().toISOString());
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/result', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { match_id, winner_id, score1, score2, extra } = req.body;
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: '試合が見つかりません' });
  if (winner_id !== match.team1_id && winner_id !== match.team2_id) {
    return res.status(400).json({ error: '勝者はこの試合の出場校から選んでください' });
  }
  db.prepare(`UPDATE matches SET winner_id = ?, score1 = ?, score2 = ?, status = 'finished',
    extra_innings = ? WHERE id = ?`)
    .run(winner_id, score1 ?? null, score2 ?? null, extra ? 1 : 0, match_id);
  broadcast();
  res.json({ ok: true });
});

// 試合の不成立（不戦勝・中止など）: ベットは全額返還扱い
app.post('/api/admin/void', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.body.match_id);
  if (!match) return res.status(404).json({ error: '試合が見つかりません' });
  db.prepare(`UPDATE matches SET status = 'void', winner_id = NULL, score1 = NULL,
    score2 = NULL, extra_innings = 0 WHERE id = ?`).run(match.id);
  broadcast();
  res.json({ ok: true });
});

// 想定外エラーはスタックを漏らさず JSON で返す
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'サーバ内部エラー' });
});

app.listen(PORT, () => {
  console.log(`甲子園予想アプリ起動: http://localhost:${PORT}`);
});
