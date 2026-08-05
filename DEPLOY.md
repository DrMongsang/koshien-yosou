# クラウドデプロイ手順（Render + Turso・無料）

仲間がスマホからベットできる「本物の予想サイト」を公開するための手順。
アカウント作成の2ステップだけ人間の作業が必要（それぞれGitHubログインで1分）。

## 1. Turso（データ置き場）— https://turso.tech

Render無料枠はディスクが再起動で消えるため、データはTursoに置く。

1. GitHubアカウントで Sign up
2. ダッシュボードで **Create Database**（名前は `koshien` など、リージョンは Tokyo/nrt）
3. 作ったDBの画面で以下の2つを控える:
   - **Database URL**（`libsql://koshien-xxxx.turso.io` の形式）
   - **Auth Token**（Generate Token で発行）

## 2. Render（アプリ本体）— https://render.com

1. GitHubアカウントで Sign up
2. **New → Blueprint** → このリポジトリ（DrMongsang/koshien-yosou）を選択
   （render.yaml を自動で読み込む）
3. 環境変数を入力:
   - `ADMIN_PASSWORD`: 管理者パスワード（**強めのものに**。ローカルの config.json とは別でよい）
   - `ADMIN_USER`: `たかし`
   - `TURSO_DATABASE_URL`: 手順1のURL
   - `TURSO_AUTH_TOKEN`: 手順1のトークン
4. Deploy。数分で `https://koshien-yosou.onrender.com` のようなURLができる

## 3. デプロイ直後にやること（重要）

1. **最初に「たかし」で新規参加する**（`ADMIN_USER` の名前は早い者勝ちで管理者になるため、必ず本人が最初に登録）
2. クラウドのDBは空で始まるので、大会データ（49校・日程・AI分析）は Claude に「クラウドに投入して」と頼めば管理APIごしに入れてくれる
3. 仲間にURLを共有 → 各自「なまえ＋好きなパスワード」で新規参加 → 優勝予想

## 運用メモ

- 無料枠は15分アクセスがないと休止し、次のアクセスで起き上がりに30〜60秒かかる（データ・ログインは消えない）
- ローカル起動（`npm start`）は今までどおり動く（環境変数がなければローカルファイルのDBを使う）
- ローカルとクラウドのデータは別物。大会運用はクラウド側に一本化するのがおすすめ
