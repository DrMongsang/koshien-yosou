// GitHub Pages 用の静的スナップショット出力
// 使い方: サーバ起動中に `npm run export` → docs/index.html を生成 → git push で公開
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3310';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oddsText = (m) => (m == null ? '—' : m.toFixed(2));
const fmtDay = (day) => {
  const d = new Date(`${day}T00:00`);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
};
const fmtTime = (iso) => (iso ? iso.slice(11, 16) : '');

(async () => {
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
  const tournOf = (id) => boot.tournaments.find((t) => t.id === id);

  const card = (m) => {
    const finished = m.status === 'finished';
    const side = (team, mult) => {
      const cls = ['pick-btn'];
      if (finished) cls.push(m.winner_id === team.id ? 'winner' : 'loser');
      return `<div class="${cls.join(' ')}">
        <span><span class="team-name">${esc(team.name)}</span><span class="team-pref">${esc(team.prefecture)}</span></span>
        <span class="odds-chip">${oddsText(mult)}</span>
      </div>`;
    };
    const ai = m.ai
      ? `<div class="ai-line">🤖 AI予想: <b>${esc((m.ai.team_id === m.team1.id ? m.team1 : m.team2).name)}</b> 優勢 ${m.ai.confidence}%${m.ai.comment ? ` — ${esc(m.ai.comment)}` : ''}</div>`
      : '';
    const foot = finished
      ? `<div class="match-foot"><span>試合終了 ${m.score1 != null ? `${m.score1} - ${m.score2}` : ''}（プール ${m.dist.p1} : ${m.dist.p2}pt）</span></div>`
      : m.locked
        ? `<div class="match-foot"><span>締切済み・オッズ確定</span></div>`
        : `<div class="match-foot"><span>締切 ${fmtTime(m.scheduled_at) || '当日8:00'}</span><span class="odds-note">オッズ変動中</span></div>`;
    return `<div class="match-card">
      <div class="match-meta"><span class="round-chip">${esc(tournOf(m.tournament_id)?.name ?? '')}｜${esc(m.round_label)} 第${m.game_no}試合 ${fmtTime(m.scheduled_at)}</span></div>
      <div class="pick-row">${side(m.team1, m.odds.mult1)}${side(m.team2, m.odds.mult2)}</div>
      ${ai}${foot}
    </div>`;
  };

  const section = (title, matches) => {
    if (!matches.length) return '';
    let html = `<h2>${title}</h2>`;
    let day = '';
    for (const m of matches) {
      if (m.day !== day) { day = m.day; html += `<div class="day-header">${fmtDay(day)}</div>`; }
      html += card(m);
    }
    return html;
  };

  const open = boot.matches.filter((m) => !m.locked);
  const closed = boot.matches.filter((m) => m.locked).slice().reverse();

  const championHtml = boot.champions.map((c) => {
    const t = tournOf(c.tournament_id);
    const withOdds = boot.teams
      .filter((x) => x.tournament_id === c.tournament_id && c.odds[x.id] != null)
      .sort((a, b) => c.odds[a.id] - c.odds[b.id]);
    const rows = withOdds.length
      ? withOdds.map((x) => `<div class="future-btn"><span>${esc(x.name)}<span class="team-pref"> ${esc(x.prefecture)}</span></span><span class="odds-chip">${oddsText(c.odds[x.id])}</span></div>`).join('')
      : '<p class="hint">優勝ベットはまだありません</p>';
    return `<h3>${esc(t?.name ?? '')}（参加コスト ${c.current_cost}pt）</h3><div class="futures-grid">${rows}</div>`;
  }).join('');

  const rankingHtml = boot.ranking.length
    ? boot.ranking.map((r) => {
        const cls = r.profit > 0 ? 'profit-plus' : r.profit < 0 ? 'profit-minus' : '';
        return `<tr><td><span class="rank-badge r${r.rank}">${r.rank}</span></td><td>${esc(r.name)}</td>
          <td class="points ${cls}">${(r.profit > 0 ? '+' : '') + r.profit}pt</td><td>${r.balance}pt</td>
          <td>${r.hits} / ${r.predicted}</td></tr>`;
      }).join('')
    : '<tr><td colspan="5" class="hint">まだ参加者がいません</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>甲子園予想ボード（読み取り専用）</title>
<style>${css}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="brand-logo">⚾</span>
    <span class="brand-name">甲子園予想ボード</span>
    <span class="brand-badge">ポイント制・賭博なし</span>
  </div>
  <div class="userbox hint">生成: ${new Date().toLocaleString('ja-JP')}（読み取り専用スナップショット）</div>
</header>
<main style="max-width:860px;margin:0 auto;padding:16px;">
${section('受付中の試合', open)}
${section('結果・締切済み', closed)}
<h2>優勝オッズ</h2>
${championHtml}
<h2>ランキング（確定収支順）</h2>
<table class="rank-table">
<thead><tr><th>順位</th><th>ニックネーム</th><th>収支</th><th>持ち点</th><th>的中 / 予想</th></tr></thead>
<tbody>${rankingHtml}</tbody>
</table>
<p class="hint" style="margin-top:20px;">本ボードは金銭・賞品を一切扱わないポイント制予想ゲームの記録です。オッズ・AI予想は参加者内の娯楽のための参考表示であり、実在の学校・選手を評価するものではありません。試合データは公開報道（高野連公式・各報道機関）をもとにしています。</p>
</main>
</body>
</html>`;

  const docs = path.join(__dirname, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'index.html'), html);
  fs.writeFileSync(path.join(docs, '.nojekyll'), '');
  console.log('docs/index.html を生成しました');
})().catch((e) => { console.error('エクスポート失敗（サーバ起動中に実行すること）:', e.message); process.exit(1); });
