// 甲子園予想アプリ — フロントエンド
const TAP_STEP = 10; // 1タップのベット増分

const state = {
  data: null,
  userId: Number(localStorage.getItem('koshien_user')) || null,
  tournamentId: Number(localStorage.getItem('koshien_tournament')) || null,
  filterBlock: '',
  filterPref: '',
  showPast: false,
};
const prevOdds = new Map(); // "matchId:teamId" → 前回描画時のオッズ（▲▼表示用）

// 都道府県 → ブロック（高校野球の地区区分）
const BLOCKS = {
  '北海道・東北': ['北北海道', '南北海道', '青森', '岩手', '秋田', '山形', '宮城', '福島'],
  '関東': ['茨城', '栃木', '群馬', '埼玉', '千葉', '東東京', '西東京', '神奈川', '山梨'],
  '北信越': ['新潟', '長野', '富山', '石川', '福井'],
  '東海': ['静岡', '愛知', '岐阜', '三重'],
  '近畿': ['滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山'],
  '中国': ['岡山', '広島', '鳥取', '島根', '山口'],
  '四国': ['香川', '徳島', '愛媛', '高知'],
  '九州・沖縄': ['福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄'],
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2500);
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '通信エラー');
  return json;
}

async function load() {
  const q = state.userId ? `?user_id=${state.userId}` : '';
  state.data = await api(`/api/bootstrap${q}`);
  if (state.userId && !state.data.users.some((u) => u.id === state.userId)) {
    state.userId = null;
    localStorage.removeItem('koshien_user');
  }
  if (!state.data.tournaments.some((t) => t.id === state.tournamentId)) {
    state.tournamentId = state.data.tournaments[0]?.id ?? null;
  }
  renderAll();
}

function renderAll() {
  renderUsers();
  renderTournamentSelect();
  renderBetBar();
  renderFilters();
  renderMatches();
  renderFutures();
  renderRanking();
  renderAdmin();
}

// select の中身を差し替えつつ、可能なら選択値を維持する
function fillSelect(el, html, keepValue = true) {
  const prev = el.value;
  el.innerHTML = html;
  if (keepValue && prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
}

// ---- ユーザー・大会セレクタ・ベットバー -----------------------------------------
function renderUsers() {
  fillSelect($('#user-select'),
    '<option value="">ユーザーを選択</option>' +
    state.data.users.map((u) =>
      `<option value="${u.id}" ${u.id === state.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join(''),
    false);
}

function renderTournamentSelect() {
  fillSelect($('#tournament-select'),
    state.data.tournaments.map((t) =>
      `<option value="${t.id}" ${t.id === state.tournamentId ? 'selected' : ''}>${esc(t.name)}</option>`).join(''),
    false);
}

function renderBetBar() {
  const bal = state.data.my_balance;
  $('#balance-chip').textContent =
    bal == null ? '持ち点 —' : `持ち点 ${bal.toLocaleString()}pt`;
  $('#relief-btn').hidden = !(bal != null && bal < state.data.min_stake);
}

// ---- 絞り込み（ブロック・都道府県） --------------------------------------------
function matchPref(m) {
  const t = state.data.tournaments.find((x) => x.id === m.tournament_id);
  return t?.kind === 'koshien' ? '全国' : m.team1.prefecture;
}

function renderFilters() {
  const prefsInData = [...new Set(state.data.matches.map(matchPref))];
  const blockOpts = ['<option value="">全ブロック</option>'];
  if (prefsInData.includes('全国')) blockOpts.push('<option value="全国">全国大会</option>');
  for (const b of Object.keys(BLOCKS)) {
    if (BLOCKS[b].some((p) => prefsInData.includes(p))) {
      blockOpts.push(`<option value="${b}">${b}</option>`);
    }
  }
  fillSelect($('#filter-block'), blockOpts.join(''), false);
  $('#filter-block').value = state.filterBlock;

  const prefPool = state.filterBlock === ''
    ? prefsInData
    : state.filterBlock === '全国' ? ['全国']
    : prefsInData.filter((p) => (BLOCKS[state.filterBlock] || []).includes(p));
  if (state.filterPref && !prefPool.includes(state.filterPref)) state.filterPref = '';
  fillSelect($('#filter-pref'),
    '<option value="">全都道府県</option>' +
    prefPool.map((p) => `<option value="${p}">${esc(p)}</option>`).join(''), false);
  $('#filter-pref').value = state.filterPref;
}

function visibleMatches() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return state.data.matches.filter((m) => {
    if (!state.showPast && m.day < todayStr) return false;
    const pref = matchPref(m);
    if (state.filterBlock === '全国' && pref !== '全国') return false;
    if (state.filterBlock && state.filterBlock !== '全国' &&
        !(BLOCKS[state.filterBlock] || []).includes(pref)) return false;
    if (state.filterPref && pref !== state.filterPref) return false;
    return true;
  });
}

// ---- 試合予想 -----------------------------------------------------------------
const fmtDay = (day) => {
  const d = new Date(`${day}T00:00`);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
};
const fmtTime = (iso) => iso ? iso.slice(11, 16) : '';
const oddsText = (m) => (m == null ? '—' : m.toFixed(2));

function oddsArrow(key, mult) {
  const prev = prevOdds.get(key);
  prevOdds.set(key, mult);
  if (prev != null && mult != null && mult !== prev) {
    return mult > prev
      ? '<span class="odds-move up">▲</span>'
      : '<span class="odds-move down">▼</span>';
  }
  return '';
}

function renderMatches() {
  const wrap = $('#match-list');
  const matches = visibleMatches();
  if (!matches.length) {
    wrap.innerHTML = '<p class="hint">条件に合う試合がありません。絞り込みを変えるか、管理タブから試合を追加してください。</p>';
    return;
  }
  let html = '';
  let currentDay = '';
  for (const m of matches) {
    if (m.day !== currentDay) {
      currentDay = m.day;
      html += `<div class="day-header">${fmtDay(m.day)}</div>`;
    }
    html += matchCard(m);
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('.pick-btn[data-match]').forEach((btn) => {
    btn.addEventListener('click', () => pick(Number(btn.dataset.match), Number(btn.dataset.team)));
  });
  wrap.querySelectorAll('.cancel-link').forEach((btn) => {
    btn.addEventListener('click', () => cancelBet(Number(btn.dataset.match)));
  });
}

function matchCard(m) {
  const finished = m.status === 'finished';
  const tourn = state.data.tournaments.find((t) => t.id === m.tournament_id);
  const btn = (team, mult) => {
    const picked = m.my_pick === team.id;
    const cls = ['pick-btn'];
    if (picked) cls.push('picked');
    if (finished) cls.push(m.winner_id === team.id ? 'winner' : 'loser');
    const arrow = m.locked ? '' : oddsArrow(`${m.id}:${team.id}`, mult);
    const stakeTag = picked && m.my_stake != null
      ? `<span class="stake-tag">${m.my_stake}pt</span>` : '';
    return `<button class="${cls.join(' ')}" data-match="${m.id}" data-team="${team.id}" ${m.locked ? 'disabled' : ''}>
      <span><span class="team-name">${esc(team.name)}</span><span class="team-pref">${esc(team.prefecture)}</span>${stakeTag}</span>
      <span class="odds-chip">${oddsText(mult)}${arrow}</span>
    </button>`;
  };

  let aiLine = '';
  if (m.ai) {
    const aiTeam = m.ai.team_id === m.team1.id ? m.team1 : m.team2;
    aiLine = `<div class="ai-line">🤖 AI予想: <b>${esc(aiTeam.name)}</b> 優勢 ${m.ai.confidence}%` +
      (m.ai.comment ? ` — ${esc(m.ai.comment)}` : '') + '</div>';
  }

  let foot;
  if (finished) {
    const score = (m.score1 != null && m.score2 != null) ? `${m.score1} - ${m.score2}` : '';
    let mine = '';
    if (m.my_pick != null) {
      mine = m.my_payout > 0
        ? `<span class="result-pill hit">○ 的中 +${m.my_payout}pt</span>`
        : `<span class="result-pill miss">× はずれ −${m.my_stake}pt</span>`;
    }
    foot = `<div class="match-foot"><span>試合終了 ${score}（プール ${m.dist.p1} : ${m.dist.p2}pt）</span>${mine}</div>`;
  } else if (m.locked) {
    foot = `<div class="match-foot"><span>締切済み・オッズ確定（プール ${m.dist.p1} : ${m.dist.p2}pt）</span></div>`;
  } else {
    const cancel = m.my_pick != null
      ? `<button class="cancel-link" data-match="${m.id}">ベット取消</button>` : '';
    foot = `<div class="match-foot"><span>締切 ${fmtTime(m.scheduled_at) || '当日8:00'}　<span class="odds-note">オッズ変動中</span></span>${cancel}</div>`;
  }

  return `<div class="match-card">
    <div class="match-meta">
      <span class="round-chip">${esc(tourn?.name ?? '')}｜${esc(m.round_label)} 第${m.game_no}試合 ${fmtTime(m.scheduled_at)}</span>
      <span>最大 ${m.max_stake}pt</span>
    </div>
    <div class="pick-row">
      ${btn(m.team1, m.odds.mult1)}
      ${btn(m.team2, m.odds.mult2)}
    </div>
    ${aiLine}
    ${foot}
  </div>`;
}

// タップでベット: 同じ学校を連打すると +10pt ずつ増額、別の学校なら 10pt で張り直し
async function pick(matchId, teamId) {
  if (!state.userId) return toast('先に右上でユーザーを選択（または参加）してください', true);
  const m = state.data.matches.find((x) => x.id === matchId);
  let stake = TAP_STEP;
  if (m && m.my_pick === teamId) {
    if (m.my_stake >= m.max_stake) return toast(`この試合の上限は ${m.max_stake}pt です`, true);
    stake = m.my_stake + TAP_STEP;
  }
  try {
    await api('/api/predictions', {
      user_id: state.userId, match_id: matchId, team_id: teamId, stake,
    });
    await load();
  } catch (e) { toast(e.message, true); }
}

async function cancelBet(matchId) {
  try {
    await api('/api/predictions/cancel', { user_id: state.userId, match_id: matchId });
    await load();
    toast('ベットを取り消しました（全額返却）');
  } catch (e) { toast(e.message, true); }
}

// ---- 長期（優勝） --------------------------------------------------------------
function renderFutures() {
  const { teams } = state.data;
  const champion = state.data.champions.find((c) => c.tournament_id === state.tournamentId);
  const grid = $('#futures-grid');
  const status = $('#futures-status');
  if (!champion) { grid.innerHTML = ''; status.textContent = ''; return; }
  $('#futures-cost').textContent = champion.current_cost;

  const myTeams = teams.filter((t) => t.tournament_id === state.tournamentId);
  if (champion.champion_team_id != null) {
    const t = teams.find((x) => x.id === champion.champion_team_id);
    status.textContent = `🏆 優勝: ${t ? t.name : '?'}`;
  } else if (champion.locked) {
    status.textContent = '決勝開始後のためロックされています';
  } else {
    const parts = [`参加コスト ${champion.current_cost}pt`];
    if (champion.lock_at) parts.push(`締切 ${new Date(champion.lock_at).toLocaleString('ja-JP')}`);
    status.textContent = parts.join('　');
  }

  grid.innerHTML = myTeams.map((t) => {
    const picked = champion.my_pick === t.id;
    const cls = ['future-btn'];
    if (picked) cls.push('picked');
    if (champion.champion_team_id === t.id) cls.push('champion');
    const stakeTag = picked && champion.my_stake != null
      ? `<span class="stake-tag">${champion.my_stake}pt</span>` : '';
    return `<button class="${cls.join(' ')}" data-team="${t.id}" ${champion.locked ? 'disabled' : ''}>
      <span>${esc(t.name)}<span class="team-pref"> ${esc(t.prefecture)}</span>${stakeTag}</span>
      <span class="odds-chip">${oddsText(champion.odds[t.id])}</span>
    </button>`;
  }).join('');

  grid.querySelectorAll('.future-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.userId) return toast('先に右上でユーザーを選択（または参加）してください', true);
      try {
        const r = await api('/api/champion', {
          user_id: state.userId, tournament_id: state.tournamentId,
          team_id: Number(btn.dataset.team),
        });
        await load();
        toast(`優勝予想にベットしました（${r.cost}pt）`);
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ---- ランキング ----------------------------------------------------------------
function renderRanking() {
  const { ranking } = state.data;
  const body = $('#ranking-body');
  if (!ranking.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">まだ参加者がいません</td></tr>';
    return;
  }
  body.innerHTML = ranking.map((r) => {
    const profitCls = r.profit > 0 ? 'profit-plus' : r.profit < 0 ? 'profit-minus' : '';
    const profitText = (r.profit > 0 ? '+' : '') + r.profit.toLocaleString();
    return `<tr class="${r.rank === 1 ? 'top' : ''}">
      <td><span class="rank-badge r${r.rank}">${r.rank}</span></td>
      <td>${esc(r.name)}</td>
      <td class="points ${profitCls}">${profitText}pt</td>
      <td>${r.balance.toLocaleString()}pt</td>
      <td>${r.hits} / ${r.predicted}${r.champion_hits > 0 ? ' 🏆' : ''}</td>
      <td>${r.relief_count > 0 ? r.relief_count : '—'}</td>
    </tr>`;
  }).join('');
}

// ---- 管理 ---------------------------------------------------------------------
function renderAdmin() {
  const { matches, teams, tournaments } = state.data;
  const tName = (id) => tournaments.find((t) => t.id === id)?.name ?? '?';
  const matchLabel = (m) =>
    `[${tName(m.tournament_id)}] ${fmtDay(m.day)} ${m.round_label}第${m.game_no}試合 ` +
    `${m.team1.name} vs ${m.team2.name}` + (m.status === 'finished' ? '【確定済】' : '');
  fillSelect($('#result-match'),
    '<option value="">試合を選択</option>' +
    matches.map((m) => `<option value="${m.id}">${esc(matchLabel(m))}</option>`).join(''));
  renderWinnerRadios();

  const tournOpts = tournaments.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  fillSelect($('#add-tournament'), tournOpts);
  fillSelect($('#team-tournament'), tournOpts);
  renderAddMatchOptions();
}

// 「試合の追加」フォームのラウンド・学校の選択肢を、選択中の大会に合わせる
function renderAddMatchOptions() {
  const tournId = Number($('#add-tournament').value);
  const t = state.data.tournaments.find((x) => x.id === tournId);
  fillSelect($('#add-round'),
    t ? t.rounds.map((r, i) =>
      `<option value="${i + 1}">${esc(r.label)}</option>`).join('') : '');
  const teamOpts = state.data.teams
    .filter((x) => x.tournament_id === tournId)
    .map((x) => `<option value="${x.id}">${esc(x.name)}（${esc(x.prefecture)}）</option>`).join('');
  fillSelect($('#add-team1'), teamOpts);
  fillSelect($('#add-team2'), teamOpts);
}

function renderWinnerRadios() {
  const row = $('#result-winner-row');
  const matchId = Number($('#result-match').value);
  const m = state.data.matches.find((x) => x.id === matchId);
  if (!m) { row.innerHTML = '<span class="hint">試合を選ぶと勝者を選択できます</span>'; return; }
  row.innerHTML = [m.team1, m.team2].map((t) =>
    `<label class="radio-label"><input type="radio" name="winner" value="${t.id}"
      ${m.winner_id === t.id ? 'checked' : ''}> ${esc(t.name)}</label>`).join('');
}

// ---- イベント -------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

$('#filter-block').addEventListener('change', (e) => {
  state.filterBlock = e.target.value;
  state.filterPref = '';
  renderFilters();
  renderMatches();
});
$('#filter-pref').addEventListener('change', (e) => {
  state.filterPref = e.target.value;
  renderMatches();
});
$('#show-past').addEventListener('change', (e) => {
  state.showPast = e.target.checked;
  renderMatches();
});

$('#relief-btn').addEventListener('click', async () => {
  if (!state.userId) return;
  try {
    await api('/api/relief', { user_id: state.userId });
    await load();
    toast('救済チップ +100pt を受け取りました');
  } catch (e) { toast(e.message, true); }
});

$('#tournament-select').addEventListener('change', (e) => {
  state.tournamentId = Number(e.target.value) || null;
  if (state.tournamentId) localStorage.setItem('koshien_tournament', state.tournamentId);
  renderAll();
});

$('#user-select').addEventListener('change', (e) => {
  state.userId = Number(e.target.value) || null;
  if (state.userId) localStorage.setItem('koshien_user', state.userId);
  else localStorage.removeItem('koshien_user');
  load().catch((err) => toast(err.message, true));
});

$('#add-user-btn').addEventListener('click', async () => {
  const name = $('#new-user-name').value.trim();
  if (!name) return toast('ニックネームを入力してください', true);
  try {
    const u = await api('/api/users', { name });
    state.userId = u.id;
    localStorage.setItem('koshien_user', u.id);
    $('#new-user-name').value = '';
    await load();
    toast(`ようこそ、${name} さん！持ち点 1000pt からスタートです`);
  } catch (e) { toast(e.message, true); }
});

$('#result-match').addEventListener('change', renderWinnerRadios);
$('#add-tournament').addEventListener('change', renderAddMatchOptions);

$('#result-submit').addEventListener('click', async () => {
  const matchId = Number($('#result-match').value);
  const winner = document.querySelector('input[name="winner"]:checked');
  if (!matchId || !winner) return toast('試合と勝者を選択してください', true);
  const s1 = $('#result-score1').value, s2 = $('#result-score2').value;
  try {
    await api('/api/admin/result', {
      match_id: matchId, winner_id: Number(winner.value),
      score1: s1 === '' ? null : Number(s1), score2: s2 === '' ? null : Number(s2),
    });
    $('#result-score1').value = ''; $('#result-score2').value = '';
    await load();
    toast('結果を確定しました');
  } catch (e) { toast(e.message, true); }
});

$('#add-match-btn').addEventListener('click', async () => {
  const day = $('#add-day').value;
  if (!day) return toast('日付を入力してください', true);
  try {
    await api('/api/admin/matches', {
      tournament_id: Number($('#add-tournament').value),
      round: Number($('#add-round').value), day,
      game_no: Number($('#add-game-no').value) || 1,
      team1_id: Number($('#add-team1').value), team2_id: Number($('#add-team2').value),
      time: $('#add-time').value || null,
    });
    await load();
    toast('試合を追加しました');
  } catch (e) { toast(e.message, true); }
});

$('#add-tourn-btn').addEventListener('click', async () => {
  const name = $('#tourn-name').value.trim();
  if (!name) return toast('大会名を入力してください', true);
  try {
    const t = await api('/api/admin/tournaments', { name, kind: $('#tourn-kind').value });
    state.tournamentId = t.id;
    localStorage.setItem('koshien_tournament', t.id);
    $('#tourn-name').value = '';
    await load();
    toast('大会を追加しました');
  } catch (e) { toast(e.message, true); }
});

$('#add-team-btn').addEventListener('click', async () => {
  const name = $('#team-name').value.trim();
  const prefecture = $('#team-pref').value.trim();
  if (!name || !prefecture) return toast('校名と都道府県を入力してください', true);
  try {
    await api('/api/admin/teams', {
      tournament_id: Number($('#team-tournament').value), name, prefecture,
    });
    $('#team-name').value = '';
    await load();
    toast('学校を追加しました');
  } catch (e) { toast(e.message, true); }
});

// ---- ライブ更新: ベットが入った瞬間に SSE で再取得（フォールバックで60秒ポーリング）
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(() => {}), 250);
}
const events = new EventSource('/api/events');
events.onmessage = scheduleReload;
setInterval(() => load().catch(() => {}), 60000);

load().catch((e) => toast(e.message, true));
