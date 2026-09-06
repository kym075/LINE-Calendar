# LINE Webhook中継Worker

GAS Webアプリでは`X-Line-Signature`ヘッダーを取得できないため、Cloudflare WorkerでLINEの署名を検証してからGASへ転送します。

## Cloudflare Workerの設定値

Workerの「Settings」→「Variables and Secrets」に、すべて暗号化されたSecretとして登録します。

| Secret名 | 設定値 |
| --- | --- |
| `LINE_CHANNEL_SECRET` | Messaging APIチャネルのチャネルシークレット |
| `GAS_WEB_APP_URL` | GAS Webアプリの`/exec`で終わるURL |
| `GAS_WEBHOOK_SECRET` | GASとWorkerだけで共有する32文字以上のランダム文字列 |

`GAS_WEBHOOK_SECRET`と同じ値を、GASのスクリプトプロパティ`LINE_WEBHOOK_SHARED_SECRET`にも設定します。

## デプロイ

1. Cloudflare DashboardでWorkerを新規作成します。
2. Workerのコードを`worker.js`の内容へ置き換えてデプロイします。
3. 上記3件のSecretを登録します。
4. Workerの`https://...workers.dev` URLをLINE DevelopersのWebhook URLへ設定します。
5. 「検証」を実行し、成功後に「Webhookの利用」を有効にします。

有効化後、Botがいるグループで`家計簿テスト`と送信し、Botから「Webhookを正常に受信できました。」と返れば接続成功です。通常のテキスト会話には返信しません。

続いて、LIFF画面から共有家計簿へ参加済みのメンバーが、同じグループで`家計簿連携`と送信します。「このグループを共有家計簿に連携しました。」と返信され、スプレッドシートに`lineGroups`シートと連携データが作成されれば完了です。

連携済みグループへレシート画像を送ると、GASがLINEから画像を取得してGeminiで解析します。解析結果が妥当なら支出へ自動登録し、日付・店名・カテゴリ・金額をグループへ返信します。

チャネルシークレット、アクセストークン、共有SecretはGitHubへコミットしません。
