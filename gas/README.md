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

共有コードには、推測されにくい12文字以上の英数字などを使用してください。これらの値はGitHubへコミットしません。

## 2. シートを作成・移行する

Apps Script上部の関数一覧から`setupApplication`を選択して実行し、権限を承認します。

- `expenses`シート：支出データ
- `members`シート：参加したLINEユーザー

新しい`expenses`ヘッダー：

```text
id | householdId | userId | userName | date | title | category | amount | createdAt | updatedAt
```

`members`ヘッダー：

```text
userId | householdId | displayName | joinedAt
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
