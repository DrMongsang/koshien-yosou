// 甲子園予想アプリ — フロントエンド
const state = {
  data: null,
  token: localStorage.getItem('koshien_token') || null,       // ユーザーのログイントークン
  adminToken: localStorage.getItem('koshien_admin') || null,  // 管理者トークン（別枠）
  tournamentId: null,  // 表示対象の大会（常に甲子園。load() で解決）
  step: Number(localStorage.getItem('koshien_step')) || 10,   // 1タップの増分（試合ベット休止中は未使用）
};
const prevOdds = new Map(); // "matchId:teamId" → 前回描画時のオッズ（▲▼表示用）

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2500);
}

async function api(path, body, token = state.token) {
  const headers = {};
  if (token) headers['x-token'] = token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, body
    ? { method: 'POST', headers, body: JSON.stringify(body) }
    : { headers });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '通信エラー');
  return json;
}
const adminApi = (path, body) => {
  // 管理者ユーザー（たかし）は自分のログイントークンがそのまま管理者権限を持つ
  const token = state.adminToken || (state.data?.me?.admin ? state.token : null);
  if (!token) throw new Error('管理タブで管理者ログインしてください');
  return api(path, body, token);
};

async function load() {
  // 管理者トークンは別ヘッダで併送（AI勝率予想は管理者にだけ返る）
  const headers = {};
  if (state.token) headers['x-token'] = state.token;
  if (state.adminToken) headers['x-admin-token'] = state.adminToken;
  const res = await fetch('/api/bootstrap', { headers });
  state.data = await res.json();
  // トークン失効（サーバ再起動など）を検知したらログアウト状態に戻す
  if (state.token && !state.data.me) {
    state.token = null;
    localStorage.removeItem('koshien_token');
  }
  // 表示は甲子園のみ（地方大会のデータはDBに残るが画面には出さない）
  state.tournamentId =
    state.data.tournaments.find((t) => t.kind === 'koshien')?.id
    ?? state.data.tournaments[0]?.id ?? null;
  renderAll();
}

function renderAll() {
  renderLogin();
  renderBetBar();
  renderMatches();
  renderBracket();
  renderFutures();
  renderChat();
  renderRanking();
  renderAdmin();
}

// ---- チャット -----------------------------------------------------------------
function renderChat() {
  const list = $('#chat-list');
  const chat = state.data.chat || [];
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  list.innerHTML = chat.length
    ? chat.map((c) => {
        const time = new Date(c.created_at).toLocaleString('ja-JP', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const adminCls = c.name === '管理者' ? ' chat-admin' : '';
        return `<div class="chat-msg">
          <span class="chat-name${adminCls}">${esc(c.name)}</span><span class="chat-time">${time}</span>
          <span class="chat-body">${esc(c.body)}</span>
        </div>`;
      }).join('')
    : '<p class="hint">まだ書き込みがありません。一番乗りでどうぞ。</p>';
  if (atBottom || !list.dataset.scrolled) list.scrollTop = list.scrollHeight;
  list.dataset.scrolled = '1';
}

async function sendChat() {
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body) return;
  if (!state.data.me) return toast('チャットの投稿にはログインが必要です', true);
  try {
    // ユーザーとしてログイン中なら本人名義、管理者パスワードのみのログインなら「管理者」名義
    const token = state.token ?? state.adminToken;
    await api('/api/chat', { body }, token);
    input.value = '';
    await load();
  } catch (e) { toast(e.message, true); }
}

const currentTournament = () =>
  state.data.tournaments.find((t) => t.id === state.tournamentId);

// ---- トーナメント表（ラウンド列形式、左→右で勝ち上がり） ------------------------
function renderBracket() {
  const t = currentTournament();
  const wrap = $('#bracket-view');
  if (!t) { wrap.innerHTML = ''; return; }
  $('#bracket-title').textContent = `トーナメント表 — ${t.name}`;
  const matches = state.data.matches.filter((m) => m.tournament_id === t.id);
  const champion = state.data.champions.find((c) => c.tournament_id === t.id);

  const cols = t.rounds.map((r, i) => {
    const round = i + 1;
    const ms = matches.filter((m) => m.round === round);
    let body;
    if (!ms.length) {
      body = '<div class="bracket-empty">組み合わせ未定</div>';
    } else {
      body = ms.map((m) => {
        const team = (x, other) => {
          const won = m.status === 'finished' && m.winner_id === x.id;
          const lost = m.status === 'finished' && m.winner_id === other.id;
          const score = m.status === 'finished' && m.score1 != null
            ? `<span class="score">${x.id === m.team1.id ? m.score1 : m.score2}</span>` : '';
          return `<div class="bracket-team ${won ? 'win' : lost ? 'lose' : ''}">
            <span>${esc(x.name)}</span>${score}
          </div>`;
        };
        const dayNote = m.status === 'void' ? '不成立'
          : `${fmtDay(m.day)}${m.extra_innings ? '・延長' : ''}`;
        return `<div class="bracket-match">
          ${team(m.team1, m.team2)}
          ${team(m.team2, m.team1)}
          <div class="bracket-day">${dayNote}</div>
        </div>`;
      }).join('');
    }
    return `<div class="bracket-col"><div class="bracket-col-title">${esc(r.label)}</div>${body}</div>`;
  });

  // 優勝列
  let champBody = '<div class="bracket-empty">—</div>';
  if (champion?.champion_team_id != null) {
    const ct = state.data.teams.find((x) => x.id === champion.champion_team_id);
    champBody = `<div class="bracket-champion">🏆 ${esc(ct?.name ?? '?')}</div>`;
  }
  cols.push(`<div class="bracket-col"><div class="bracket-col-title">優勝</div>${champBody}</div>`);

  wrap.innerHTML = cols.join('');
}

// select の中身を差し替えつつ、可能なら選択値を維持する
function fillSelect(el, html, keepValue = true) {
  const prev = el.value;
  el.innerHTML = html;
  if (keepValue && prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
}

// ---- ログイン・大会セレクタ・ベットバー -----------------------------------------
function renderLogin() {
  const me = state.data.me;
  $('#login-box').hidden = !!me;
  $('#me-box').hidden = !me;
  $('#login-hint').hidden = !!me;
  if (me) $('#me-name').textContent = `⚾ ${me.name ?? '管理者'}`;
}

function renderBetBar() {
  const bal = state.data.my_balance;
  $('#balance-chip').textContent =
    bal == null ? '持ち点 —' : `持ち点 ${bal.toLocaleString()}pt`;
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('selected', Number(c.dataset.stake) === state.step);
  });
  // 救済チップは試合ベット用の仕組みなので、優勝予想のみの今大会では出さない
  $('#relief-btn').hidden = !(state.data.match_betting && bal != null && bal < state.data.min_stake);
}

// ---- 表示対象は甲子園の全試合（日付順） ----------------------------------------
function visibleMatches() {
  return state.data.matches.filter((m) => m.tournament_id === state.tournamentId);
}

// ---- 試合予想 -----------------------------------------------------------------
const fmtDay = (day) => {
  const d = new Date(`${day}T00:00`);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
};
// 甲子園の「大会第N日」表記（開幕 8/5 起点。順延時はズレるが表示のみ）
const KOSHIEN_OPENING = '2026-08-05';
function koshienDayTag(m) {
  const t = state.data.tournaments.find((x) => x.id === m.tournament_id);
  if (t?.kind !== 'koshien') return '';
  const n = Math.round(
    (new Date(`${m.day}T00:00`) - new Date(`${KOSHIEN_OPENING}T00:00`)) / 86400000) + 1;
  return n >= 1 ? `　大会第${n}日` : '';
}
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
    wrap.innerHTML = '<p class="hint">試合はまだ登録されていません。</p>';
    return;
  }
  let html = '';
  let currentDay = '';
  for (const m of matches) {
    if (m.day !== currentDay) {
      currentDay = m.day;
      html += `<div class="day-header">${fmtDay(m.day)}${koshienDayTag(m)}</div>`;
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
  const betting = state.data.match_betting;
  const finished = m.status === 'finished';
  const voided = m.status === 'void';
  const tourn = state.data.tournaments.find((t) => t.id === m.tournament_id);
  const btn = (team, mult) => {
    const picked = m.my_pick === team.id;
    const cls = ['pick-btn'];
    if (picked) cls.push('picked');
    if (finished) cls.push(m.winner_id === team.id ? 'winner' : 'loser');
    const arrow = (!betting || m.locked) ? '' : oddsArrow(`${m.id}:${team.id}`, mult);
    const stakeTag = picked && m.my_stake != null
      ? `<span class="stake-tag">${m.my_stake.toLocaleString()}pt</span>` : '';
    const oddsChip = betting ? `<span class="odds-chip">${oddsText(mult)}${arrow}</span>` : '';
    return `<button class="${cls.join(' ')}" data-match="${m.id}" data-team="${team.id}" ${!betting || m.locked || voided ? 'disabled' : ''}>
      <span><span class="team-name">${esc(team.name)}</span><span class="team-pref">${esc(team.prefecture)}</span>${stakeTag}</span>
      ${oddsChip}
    </button>`;
  };

  let aiLine = '';
  if (m.ai) {
    const aiTeam = m.ai.team_id === m.team1.id ? m.team1 : m.team2;
    aiLine = `<div class="ai-line">🤖 AI予想: <b>${esc(aiTeam.name)}</b> 優勢 ${m.ai.confidence}%` +
      (m.ai.comment ? ` — ${esc(m.ai.comment)}` : '') + '</div>';
  }

  let foot;
  if (voided) {
    foot = `<div class="match-foot"><span>試合不成立${betting ? ' — ベットは全額返還されました' : ''}</span></div>`;
  } else if (finished) {
    const score = (m.score1 != null && m.score2 != null) ? `${m.score1} - ${m.score2}` : '';
    const extraTag = m.extra_innings ? '（延長）' : '';
    let mine = '';
    if (betting && m.my_pick != null) {
      if (m.extra_innings) {
        mine = m.my_payout > 0
          ? `<span class="result-pill hit">△ 延長勝ち 半金返還 +${m.my_payout}pt</span>`
          : `<span class="result-pill miss">× 没収 −${m.my_stake}pt</span>`;
      } else {
        mine = m.my_payout > 0
          ? `<span class="result-pill hit">○ 的中 +${m.my_payout}pt</span>`
          : `<span class="result-pill miss">× はずれ −${m.my_stake}pt</span>`;
      }
    }
    const pool = betting ? `（プール ${m.dist.p1} : ${m.dist.p2}pt）` : '';
    foot = `<div class="match-foot"><span>試合終了${extraTag} ${score}${pool}</span>${mine}</div>`;
  } else if (!betting) {
    foot = `<div class="match-foot"><span>開始 ${fmtTime(m.scheduled_at) || '未定'}</span></div>`;
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
    </div>
    <div class="pick-row">
      ${btn(m.team1, m.odds.mult1)}
      ${btn(m.team2, m.odds.mult2)}
    </div>
    ${aiLine}
    ${foot}
  </div>`;
}

// タップでベット: 同じ学校を連打すると選択中の増分ずつ積み増し、別の学校なら増分額で張り直し
async function pick(matchId, teamId) {
  if (!state.data.match_betting) {
    return toast('今大会は優勝予想のみです（優勝予想タブからどうぞ）', true);
  }
  if (!state.data.me || state.data.me.user_id == null) {
    return toast('右上からニックネームとパスワードでログインしてください', true);
  }
  const m = state.data.matches.find((x) => x.id === matchId);
  const stake = (m && m.my_pick === teamId) ? m.my_stake + state.step : state.step;
  try {
    await api('/api/predictions', { match_id: matchId, team_id: teamId, stake });
    await load();
  } catch (e) { toast(e.message, true); }
}

async function cancelBet(matchId) {
  try {
    await api('/api/predictions/cancel', { match_id: matchId });
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

  const myTeams = teams.filter((t) => t.tournament_id === state.tournamentId);
  const myPicks = champion.my_picks || [];

  if (champion.champion_team_id != null) {
    const t = teams.find((x) => x.id === champion.champion_team_id);
    status.textContent = `🏆 優勝: ${t ? t.name : '?'}` +
      (champion.pot != null ? `　ポット ${champion.pot.toLocaleString()}pt の行方はランキング参照` : '');
  } else if (champion.picks_open) {
    status.textContent = `予想公開済み・ベット締切　ポット ${champion.pot?.toLocaleString() ?? '—'}pt`;
  } else if (champion.locked) {
    status.textContent = '決勝開始後のためロックされています';
  } else {
    status.textContent =
      `クローズド期間中 — お互いの予想は公開まで見えません（あなた: ${myPicks.length}/${champion.max_picks}口）`;
  }

  const pickersOf = (teamId) =>
    (champion.picks || []).filter((p) => p.team_id === teamId).map((p) => p.name);

  grid.innerHTML = myTeams.map((t) => {
    const picked = myPicks.includes(t.id);
    const cls = ['future-btn'];
    if (picked) cls.push('picked');
    if (champion.champion_team_id === t.id) cls.push('champion');
    const stakeTag = picked ? `<span class="stake-tag">${champion.unit}pt</span>` : '';
    const names = champion.picks ? pickersOf(t.id) : [];
    const nameTag = names.length
      ? `<span class="pick-names">${esc(names.join('・'))}</span>` : '';
    return `<button class="${cls.join(' ')}" data-team="${t.id}" ${champion.locked ? 'disabled' : ''}>
      <span>${esc(t.name)}<span class="team-pref"> ${esc(t.prefecture)}</span>${stakeTag}</span>
      ${nameTag}
    </button>`;
  }).join('');

  renderAiAnalysis(champion);

  grid.querySelectorAll('.future-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.data.me || state.data.me.user_id == null) {
        return toast('右上からニックネームとパスワードでログインしてください', true);
      }
      const teamId = Number(btn.dataset.team);
      try {
        if (myPicks.includes(teamId)) {
          await api('/api/champion/cancel', { tournament_id: state.tournamentId, team_id: teamId });
          await load();
          toast(`この口を取り消しました（${champion.unit.toLocaleString()}pt返却）`);
        } else {
          const r = await api('/api/champion', {
            tournament_id: state.tournamentId, team_id: teamId,
          });
          await load();
          toast(`優勝ベットしました（${r.cost.toLocaleString()}pt）`);
        }
      } catch (e) { toast(e.message, true); }
    });
  });
}

// AI分析パネル（サーバが管理者にだけ ai_analysis を返す。理論値EV降順で表示）
function renderAiAnalysis(champion) {
  const panel = $('#ai-analysis');
  const rows = champion?.ai_analysis;
  if (!rows?.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#ai-analysis-body').innerHTML = rows
    .map((a) => {
      const t = state.data.teams.find((x) => x.id === a.team_id);
      return `<div class="ai-row">
        <div class="ai-row-head">
          <b>${esc(t?.name ?? '?')}</b><span class="team-pref">${esc(t?.prefecture ?? '')}</span>
          <span class="ai-stat">優勝確率 ${a.probability}%</span>
          ${a.reach ? `<span class="ai-stat">予想到達 ${esc(a.reach)}</span>` : ''}
        </div>
        <div class="ai-row-body"><b>理由:</b> ${esc(a.reason)}${a.hypothesis ? `<br><b>仮説:</b> ${esc(a.hypothesis)}` : ''}</div>
      </div>`;
    }).join('');
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
      <td>${r.champion_hits} / ${r.champion_total}${r.champion_hits > 0 ? ' 🏆' : ''}</td>
      <td>${r.relief_count > 0 ? r.relief_count : '—'}</td>
    </tr>`;
  }).join('');
}

// ---- 管理 ---------------------------------------------------------------------
function renderAdmin() {
  $('#admin-status').textContent =
    (state.adminToken || state.data.me?.admin) ? '✔ 管理者ログイン中' : '';
  const champ = state.data.champions.find((c) => c.tournament_id === state.tournamentId);
  $('#champ-open-status').textContent = champ
    ? (champ.picks_open ? '現在: 公開済み（締切中）' : '現在: クローズド（受付中）')
    : '';
  const { matches, teams, tournaments } = state.data;
  const tName = (id) => tournaments.find((t) => t.id === id)?.name ?? '?';
  const matchLabel = (m) =>
    `[${tName(m.tournament_id)}] ${fmtDay(m.day)} ${m.round_label}第${m.game_no}試合 ` +
    `${m.team1.name} vs ${m.team2.name}` +
    (m.status === 'finished' ? '【確定済】' : m.status === 'void' ? '【不成立】' : '');
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

async function doAuth(path) {
  const name = $('#login-name').value.trim();
  const password = $('#login-pass').value;
  if (!name || !password) return toast('ニックネームとパスワードを入力してください', true);
  try {
    const r = await api(path, { name, password }, null);
    state.token = r.token;
    localStorage.setItem('koshien_token', r.token);
    $('#login-pass').value = '';
    await load();
    toast(`ようこそ、${r.name} さん！`);
  } catch (e) { toast(e.message, true); }
}
$('#login-btn').addEventListener('click', () => doAuth('/api/login'));
$('#signup-btn').addEventListener('click', () => doAuth('/api/users'));
$('#logout-btn').addEventListener('click', async () => {
  state.token = null;
  localStorage.removeItem('koshien_token');
  await load();
});

$('#admin-login-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/login', { password: $('#admin-pass').value }, null);
    state.adminToken = r.token;
    localStorage.setItem('koshien_admin', r.token);
    $('#admin-pass').value = '';
    await load(); // AI勝率予想の表示を反映
    toast('管理者としてログインしました（AI勝率予想が表示されます）');
  } catch (e) { toast(e.message, true); }
});

$('#relief-btn').addEventListener('click', async () => {
  try {
    await api('/api/relief', {});
    await load();
    toast('救済チップ +100pt を受け取りました');
  } catch (e) { toast(e.message, true); }
});

async function setChampOpen(open) {
  try {
    await adminApi('/api/admin/champion-open', { tournament_id: state.tournamentId, open });
    await load();
    toast(open ? '予想を公開しました（ベット締切）' : '予想を非公開に戻しました');
  } catch (e) { toast(e.message, true); }
}
$('#champ-open-btn').addEventListener('click', () => {
  if (confirm('全員のピックを公開し、ベットを締め切ります。よろしいですか？')) setChampOpen(true);
});
$('#champ-close-btn').addEventListener('click', () => setChampOpen(false));

$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) sendChat();
});

$('#result-match').addEventListener('change', renderWinnerRadios);
$('#add-tournament').addEventListener('change', renderAddMatchOptions);

$('#result-submit').addEventListener('click', async () => {
  const matchId = Number($('#result-match').value);
  const winner = document.querySelector('input[name="winner"]:checked');
  if (!matchId || !winner) return toast('試合と勝者を選択してください', true);
  const s1 = $('#result-score1').value, s2 = $('#result-score2').value;
  try {
    await adminApi('/api/admin/result', {
      match_id: matchId, winner_id: Number(winner.value),
      score1: s1 === '' ? null : Number(s1), score2: s2 === '' ? null : Number(s2),
      extra: $('#result-extra').checked,
    });
    $('#result-score1').value = ''; $('#result-score2').value = '';
    $('#result-extra').checked = false;
    await load();
    toast('結果を確定しました');
  } catch (e) { toast(e.message, true); }
});

$('#result-void').addEventListener('click', async () => {
  const matchId = Number($('#result-match').value);
  if (!matchId) return toast('試合を選択してください', true);
  if (!confirm('この試合を不成立にして、全ベットを返還しますか？')) return;
  try {
    await adminApi('/api/admin/void', { match_id: matchId });
    await load();
    toast('試合を不成立にしました（全額返還）');
  } catch (e) { toast(e.message, true); }
});

$('#add-match-btn').addEventListener('click', async () => {
  const day = $('#add-day').value;
  if (!day) return toast('日付を入力してください', true);
  try {
    await adminApi('/api/admin/matches', {
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
    const t = await adminApi('/api/admin/tournaments', { name, kind: $('#tourn-kind').value });
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
    await adminApi('/api/admin/teams', {
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
