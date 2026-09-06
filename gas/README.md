# LIFF共有家計簿の設定手順

この構成では、LIFFが取得した生のIDトークンをGASへ送り、GASがLINEの検証APIで本人確認します。クライアントから送られたユーザーIDや表示名は認証には使用しません。

二人は初回に同じ共有コードを入力し、同じ`householdId`へ参加します。参加後は二人で同じ支出を閲覧・追加・編集・削除できます。

## 1. GoogleスプレッドシートとGASを準備する

1. Googleスプレッドシートを作成します。
2. 「拡張機能」→「Apps Script」を開きます。
3. このフォルダの`Code.gs`を貼り付けて保存します。
4. Apps Script左側の「プロジェクトの設定」→「スクリプト プロパティ」に次の4件を設定します。

| プロパティ | 設定値 |
| --- | --- |
| `SPREADSHEET_ID` | スプレッドシートURLの`/d/`と`/edit`の間の文字列 |
| `LINE_CHANNEL_ID` | LINEログインチャネルのチャネルID |
| `HOUSEHOLD_ID` | 二人共通の内部ID。例：`our-home` |
| `HOUSEHOLD_JOIN_CODE` | 二人だけが知る十分に長い共有コード |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | Messaging APIチャネルの長期チャネルアクセストークン |
| `LINE_WEBHOOK_SHARED_SECRET` | Webhook中継Workerと共有する32文字以上のランダム文字列 |
| `GEMINI_API_KEY` | Google AI Studioで発行したGemini APIキー |
| `GEMINI_MODEL` | レシート解析モデル。例：`gemini-2.5-flash` |
| `GEMINI_FALLBACK_MODEL` | 任意。混雑時の予備モデル。未設定時は`gemini-2.5-flash` |

共有コードには、推測されにくい12文字以上の英数字などを使用してください。これらの値はGitHubへコミットしません。

## 2. シートを作成・移行する

Apps Script上部の関数一覧から`setupApplication`を選択して実行し、権限を承認します。

- `expenses`シート：支出データ
- `members`シート：参加したLINEユーザー
- `lineGroups`シート：共有家計簿へ連携したLINEグループ
- `receiptJobs`シート：レシート画像の処理状態と二重登録防止情報

新しい`expenses`ヘッダー：

```text
id | householdId | userId | userName | date | title | category | amount | createdAt | updatedAt
```

`members`ヘッダー：

```text
userId | householdId | displayName | joinedAt
```

`lineGroups`ヘッダー：

```text
groupId | householdId | linkedBy | linkedAt
```

`receiptJobs`ヘッダー：

```text
messageId | householdId | userId | status | expenseId | errorCode | createdAt | updatedAt | errorDetail
```

旧7列形式の`expenses`シートがある場合、`setupApplication`が新形式へ移行します。既存データの登録者は「移行データ」と表示されます。念のため実行前にスプレッドシートをコピーしておくことを推奨します。

## 3. GASをWebアプリとして再デプロイする

1. 「デプロイ」→「デプロイを管理」を開きます。
2. 既存デプロイを編集します。
3. バージョンで「新バージョン」を選びます。
4. 「次のユーザーとして実行」は「自分」にします。
5. 「アクセスできるユーザー」は「全員」にします。
6. デプロイし、`/exec`で終わるURLを控えます。

GETでURLを開くと、次が表示されればGASは稼働しています。

```json
{"success":true,"data":{"status":"ok"}}
```

支出APIはすべてPOSTで、生のLINE IDトークンが必要です。URLを知っているだけでは支出を操作できません。

## 4. LINE DevelopersでLIFFアプリを作成する

1. LINE Developersコンソールでプロバイダーを作成または選択します。
2. LINEログインチャネルを作成します。
3. LIFFアプリを追加します。
4. サイズは`Full`を選びます。
5. Endpoint URLには、後述するGitHub PagesのHTTPS URLを設定します。
6. Scopeは少なくとも`openid`と`profile`を有効にします。
7. 発行されたLIFF IDを控えます。

LIFF IDとLINEログインチャネルIDは別の値です。GASの`LINE_CHANNEL_ID`にはチャネルID、フロントの設定にはLIFF IDを使用します。

## 5. GitHub Secretsを設定する

GitHubリポジトリの「Settings」→「Secrets and variables」→「Actions」で、次のRepository secretsを作成します。

| Secret名 | 設定値 |
| --- | --- |
| `GAS_API_URL` | GASの`/exec`で終わるURL |
| `LIFF_ID` | LINE Developersで発行されたLIFF ID |

実際の値はソースコードへ書かれません。GitHub Actionsが公開時に`config.js`を生成します。

## 6. GitHub Pagesを有効にする

1. GitHubの「Settings」→「Pages」を開きます。
2. Sourceで「GitHub Actions」を選択します。
3. `main`へ変更を反映するか、Actions画面から`Deploy to GitHub Pages`を実行します。
4. デプロイ完了後に表示されるHTTPS URLを確認します。
5. そのURLをLINE DevelopersのLIFF Endpoint URLへ設定します。

Endpoint URLを変更した後は、LIFF URLからアプリを開いてください。`file://`や通常のローカルHTTP URLはLIFFの本番確認には使用できません。

## 7. ローカル設定

ローカル確認用の`config.js`はGit管理対象外です。`config.example.js`を参考に設定します。

```javascript
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/デプロイID/exec",
  LIFF_ID: "発行されたLIFF ID",
};
```

ただしLINEログインのリダイレクト先はLIFF Endpoint URLと一致する必要があるため、最終確認はGitHub Pages上で行います。

## 8. 二人で参加して確認する

1. あなたのLINEからLIFF URLを開きます。
2. 初回の認可画面を承認します。
3. 共有コードを入力します。
4. `members`シートに自分が追加されたことを確認します。
5. 彼女のLINEへLIFF URLと共有コードを別々に伝えます。
6. 彼女も同じ共有コードで参加します。
7. 片方が支出を追加し、もう片方が再読み込みして同じ支出を確認します。
8. 明細に登録者名が表示されることを確認します。
9. 追加・編集・削除後に`expenses`シートも更新されることを確認します。

## API概要

すべての操作はGAS WebアプリURLへのPOSTです。

- `session`：参加状態の確認
- `join`：共有コードで家計簿へ参加
- `list`：同じ`householdId`の支出一覧
- `create`：支出追加。登録者は検証済みLINEユーザーから決定
- `update`：同じ家計簿内の支出更新
- `delete`：同じ家計簿内の支出削除

IDトークンは保存・ログ出力せず、リクエストごとにLINEの検証APIで確認します。

## LINE Webhookの受信

GAS WebアプリではLINE署名が入るHTTPヘッダーを取得できないため、LINE WebhookをGASへ直接接続しません。`worker/worker.js`のCloudflare Workerで署名を検証し、検証済みのリクエストだけをGASへ転送します。

設定と確認手順は`worker/README.md`を参照してください。`家計簿テスト`でWebhookを確認した後、既存メンバーがグループ内で`家計簿連携`と送ると、そのグループが共有家計簿へ紐付きます。連携済みグループでは、共有家計簿のメンバーが送った画像だけを受け付けます。

画像はLINEから一時的に取得してGemini APIで解析し、店名・日付・カテゴリ・合計金額がすべて妥当な場合だけ`expenses`へ自動登録します。503では同じモデルを一度再試行し、それでも混雑中の場合は予備モデルへ切り替えます。画像本体やGeminiの生の応答は保存しません。LINEから同じWebhookが再送されても、`receiptJobs`の`messageId`によって二重登録を防ぎます。通常の会話には返信しません。
