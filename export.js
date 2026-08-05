// GitHub Pages 用の静的スナップショット出力
// 使い方: サーバ起動中に `npm run export` → docs/index.html を生成 → git push で公開
// 今大会のゲームは優勝予想のみ: ボードは日程・結果＋優勝オッズ＋ランキングを載せる
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
  // ボードは甲子園のみ（地方大会はDBに残るが掲載しない）
  const koshienT = boot.tournaments.find((t) => t.kind === 'koshien');
  boot.matches = boot.matches.filter((m) => m.tournament_id === koshienT?.id);
  boot.champions = boot.champions.filter((c) => c.tournament_id === koshienT?.id);

  const card = (m) => {
    const finished = m.status === 'finished';
    const side = (team) => {
      const cls = ['pick-btn'];
      if (finished) cls.push(m.winner_id === team.id ? 'winner' : 'loser');
      return `<div class="${cls.join(' ')}">
        <span><span class="team-name">${esc(team.name)}</span><span class="team-pref">${esc(team.prefecture)}</span></span>
      </div>`;
    };
    const foot = m.status === 'void'
      ? `<div class="match-foot"><span>試合不成立</span></div>`
      : finished
        ? `<div class="match-foot"><span>試合終了${m.extra_innings ? '（延長）' : ''} ${m.score1 != null ? `${m.score1} - ${m.score2}` : ''}</span></div>`
        : `<div class="match-foot"><span>開始 ${fmtTime(m.scheduled_at) || '未定'}</span></div>`;
    return `<div class="match-card">
      <div class="match-meta"><span class="round-chip">${esc(tournOf(m.tournament_id)?.name ?? '')}｜${esc(m.round_label)} 第${m.game_no}試合 ${fmtTime(m.scheduled_at)}</span></div>
      <div class="pick-row">${side(m.team1)}${side(m.team2)}</div>
      ${foot}
    </div>`;
  };

  // 甲子園の「大会第N日」表記（開幕 8/5 起点）
  const dayTag = (m) => {
    if (tournOf(m.tournament_id)?.kind !== 'koshien') return '';
    const n = Math.round(
      (new Date(`${m.day}T00:00`) - new Date('2026-08-05T00:00')) / 86400000) + 1;
    return n >= 1 ? `　大会第${n}日` : '';
  };
  const section = (title, matches) => {
    if (!matches.length) return '';
    let html = `<h2>${title}</h2>`;
    let day = '';
    for (const m of matches) {
      if (m.day !== day) { day = m.day; html += `<div class="day-header">${fmtDay(day)}${dayTag(m)}</div>`; }
      html += card(m);
    }
    return html;
  };

  const upcoming = boot.matches.filter((m) => m.status === 'scheduled');
  const done = boot.matches.filter((m) => m.status !== 'scheduled').slice().reverse();

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

  // トーナメント表（甲子園。ラウンド列形式）
  const koshien = boot.tournaments.find((t) => t.kind === 'koshien');
  const bracketHtml = koshien ? (() => {
    const ms = boot.matches.filter((m) => m.tournament_id === koshien.id);
    const champion = boot.champions.find((c) => c.tournament_id === koshien.id);
    const cols = koshien.rounds.map((r, i) => {
      const list = ms.filter((m) => m.round === i + 1);
      const body = list.length ? list.map((m) => {
        const team = (x, other) => {
          const won = m.status === 'finished' && m.winner_id === x.id;
          const lost = m.status === 'finished' && m.winner_id === other.id;
          const score = m.status === 'finished' && m.score1 != null
            ? `<span class="score">${x.id === m.team1.id ? m.score1 : m.score2}</span>` : '';
          return `<div class="bracket-team ${won ? 'win' : lost ? 'lose' : ''}"><span>${esc(x.name)}</span>${score}</div>`;
        };
        return `<div class="bracket-match">${team(m.team1, m.team2)}${team(m.team2, m.team1)}
          <div class="bracket-day">${m.status === 'void' ? '不成立' : fmtDay(m.day) + (m.extra_innings ? '・延長' : '')}</div></div>`;
      }).join('') : '<div class="bracket-empty">組み合わせ未定</div>';
      return `<div class="bracket-col"><div class="bracket-col-title">${esc(r.label)}</div>${body}</div>`;
    });
    let champBody = '<div class="bracket-empty">—</div>';
    if (champion?.champion_team_id != null) {
      const ct = boot.teams.find((x) => x.id === champion.champion_team_id);
      champBody = `<div class="bracket-champion">🏆 ${esc(ct?.name ?? '?')}</div>`;
    }
    cols.push(`<div class="bracket-col"><div class="bracket-col-title">優勝</div>${champBody}</div>`);
    return `<h2>トーナメント表（甲子園）</h2><div class="bracket">${cols.join('')}</div>`;
  })() : '';

  const rankingHtml = boot.ranking.length
    ? boot.ranking.map((r) => {
        const cls = r.profit > 0 ? 'profit-plus' : r.profit < 0 ? 'profit-minus' : '';
        return `<tr><td><span class="rank-badge r${r.rank}">${r.rank}</span></td><td>${esc(r.name)}</td>
          <td class="points ${cls}">${(r.profit > 0 ? '+' : '') + r.profit}pt</td><td>${r.balance}pt</td>
          <td>${r.champion_hits} / ${r.champion_total}</td></tr>`;
      }).join('')
    : '<tr><td colspan="5" class="hint">まだ参加者がいません</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>甲子園予想ボード（読み取り専用）</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@500;700;800&display=swap" rel="stylesheet">
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
<p class="hint">今大会のゲームは<b>優勝予想のみ</b>です。オッズは参加者の優勝予想の分布（人数比）で変動します。</p>
${bracketHtml}
<h2>優勝オッズ</h2>
${championHtml}
<h2>ランキング（確定収支順）</h2>
<table class="rank-table">
<thead><tr><th>順位</th><th>ニックネーム</th><th>収支</th><th>持ち点</th><th>優勝予想</th></tr></thead>
<tbody>${rankingHtml}</tbody>
</table>
${section('今後の試合', upcoming)}
${section('結果', done)}
<p class="hint" style="margin-top:20px;">本ボードは金銭・賞品を一切扱わないポイント制予想ゲームの記録です。オッズは参加者内の娯楽のための参考表示であり、実在の学校・選手を評価するものではありません。試合データは公開報道（高野連公式・各報道機関）をもとにしています。</p>
</main>
</body>
</html>`;

  const docs = path.join(__dirname, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'index.html'), html);
  fs.writeFileSync(path.join(docs, '.nojekyll'), '');
  console.log('docs/index.html を生成しました');
})().catch((e) => { console.error('エクスポート失敗（サーバ起動中に実行すること）:', e.message); process.exit(1); });
