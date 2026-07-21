# Cloudflare Containers + Discord Bot

Cloudflare Containers 上で Discord Bot を動かし、ボイスチャンネル（VC）および Stage チャンネルで音声を送受信するための設定と注意点。実機（CF Containers）で VC・Stage の双方について join → 送出 → 受信を確認した結果に基づく。

## 前提と要件

- **Cloudflare Containers**: コンテナイメージを Durable Object が管理し、Worker がリクエストの入口になる構成。`@cloudflare/containers` の [`Container` クラスは `DurableObject` を継承する](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1034)（[Container Interface](https://developers.cloudflare.com/containers/container-class/) / [Durable Object Container](https://developers.cloudflare.com/durable-objects/api/container/)）。本ドキュメントで「コンテナ」はこの DO が管理する 1 インスタンスを指す。
- **アウトバウンド egress が必須**: Discord ゲートウェイ（WebSocket）と voice の戻り UDP に到達するため。`Container` の [`enableInternet`](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1063) を有効にする。無効だと接続そのものが成立しない。
- ランタイムは Node.js。実機で動作確認したライブラリ:
  - `discord.js` 14.26.4
  - `@discordjs/voice` 0.19.2
  - `prism-media` 1.3.5（Opus デコード）
  - `sodium-native` 4.3.3 / `@discordjs/opus` 0.10.0（暗号・Opus。ネイティブモジュール）

## Cloudflare 側の設定

### wrangler 設定

```jsonc
{
  "containers": [
    { "class_name": "MyContainer", "image": "./container/Dockerfile", "max_instances": 1, "instance_type": "standard-3" }
  ],
  "durable_objects": { "bindings": [{ "name": "MY_CONTAINER", "class_name": "MyContainer" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyContainer"] }]
}
```

- `max_instances: 1`: コンテナを 1 インスタンス（DO シングルトン）で常駐させる。
- `migrations` は `new_sqlite_classes`（`new_classes` ではない）を使う。

### instance_type の選定

- 既定は `lite`（1/16 vCPU）。選択肢は lite〜standard-4 の 6 種（[Limits and Instance Types](https://developers.cloudflare.com/containers/platform-details/limits/)）。
- 本用途は 1080p H.264 のリアルタイムエンコード（「Cloudflare Containers + YouTube RTMPS」ドキュメント参照）が CPU の支配項になる。fractional vCPU の `lite`（1/16）・`basic`（1/4）では不足。`standard-3`（2 vCPU / 8 GiB）で定常 CPU 約 35%（実測）と余裕があり、これを起点にする。乗り切らなければ `standard-4`（4 vCPU）へ。

### Container サブクラスのプロパティ

`@cloudflare/containers` の `Container` を継承したクラスに設定する（値は環境に合わせる）:

- [`enableInternet`](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1063): egress。前述のとおり有効にする。
- [`sleepAfter`](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1057): アイドルで sleep するまでの時間。**短め（例 `2m`）にする**（理由は「デプロイ更新」節）。
- [`defaultPort`](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1051): コンテナ内サーバの待受ポート。
- [`envVars`](https://github.com/cloudflare/containers/blob/a5fd50adb0653001dd8d34b7ede3d7d059c61c96/src/lib/container.ts#L1061): secret / vars をコンテナ起動時の環境変数として渡す。

### Secret

`wrangler secret put <NAME>` で投入する（コンテナ起動時に `envVars` 経由で渡す）:

- `DISCORD_BOT_TOKEN`: Discord App（後述）が発行する **Bot トークン**。
- `DISCORD_GUILD_ID`: 接続先 **サーバー（guild）の ID**。
- `DISCORD_CHANNEL_ID`: 接続先 **VC / Stage チャンネルの ID**。

**コンテナが読むのは CF 上の secret であって、ローカルの `.env` ではない。** ローカルの検証ツールが `.env` を、実行コンテナが CF secret を、と別々に参照するため両者はズレやすい。接続先のサーバーやチャンネルを変えたら、**Containers 側の CF secret を更新する**（ローカル `.env` を直すだけでは実行コンテナに反映されない）。

## Discord App と discord.js の Client

用語を分けて扱う。

- **Discord App**: Discord 開発者ポータルで登録する Bot アプリ本体。Bot トークンの発行、（必要なら）Privileged Intents の有効化、対象サーバーへの招待と権限付与はこの App／サーバー設定側の作業。
- **discord.js の Client インスタンス**: コンテナ内でその App として動く接続。設定は次のとおり:
  - Intents に `Guilds` と `GuildVoiceStates` を含める（voice state 更新の受信に必要）。
  - 受信する場合は self-deaf を無効にする（有効だと音声が届かない）。送出可否は self-mute で決まる。

## 通常 VC と Stage の違い

- **通常 VC**: 接続すればそのまま送受信できる。
- **Stage**: 接続直後は audience（suppressed）で **送出できない**（受信は audience のままでも可能）。送出するには speaker へ昇格する = Discord API で自分の voice state の suppress を解除する。前提として、**live な Stage Instance**（Stage が開始されている）と、Bot 側の `Mute Members` またはモデレーター権限が要る。チャンネル種別で VC / Stage を判定して分岐する。

## Bot に付与する権限

Bot が対象チャンネルで持つべき権限:

- VC: `Connect`（接続）、送出するなら `Speak`。
- Stage: 上記に加え、speaker 昇格のため `Mute Members` またはモデレーター権限。

## 音声の受信

- 参加者の発話開始を契機に、その参加者の Opus ストリームを購読して PCM（48kHz / stereo / s16le）へデコードする。
- 1 つの接続で送出と受信を同時に行える（full-duplex）。自分が送出した音声は自分の受信ストリームには現れない。
- 受信は Discord が永続サポートを明言していない領域だが、実機で継続受信・デコードを確認済み。

## デプロイ更新（rollout）

- **rollout が必要になる条件**: コンテナのコード（イメージ）または secret を変更したとき。
- **理由**: コンテナは常駐する DO シングルトンなので、稼働中インスタンスは**既存のイメージ・既存の環境変数のまま動き続ける**。`wrangler deploy --containers-rollout immediate` を打っても稼働中インスタンスは置き換わらず（sleep からの起床でも旧イメージのまま）、新しいコード / secret を反映するにはインスタンスを作り直す必要がある。
- `sleepAfter` を短くするのは、アイドル時に確実に sleep させ、新インスタンスとして起き直させやすくするため。
- 新規インスタンスの初回起動（provisioning）には時間がかかる（数秒〜数分）。

## 再現ビルド

- lockfile（`package-lock.json`）をコミットし、Dockerfile では固定インストール（`npm ci`）を使う。lockfile が無いと caret 範囲（`^14.x` 等）がビルドごとに解決され、`discord.js` などが意図せず別バージョンに変わる。
- ネイティブモジュール（`sodium-native` / `@discordjs/opus`）がソースビルドにフォールバックする場合があるため、ビルドイメージに `python3` / `build-essential` を含める。
