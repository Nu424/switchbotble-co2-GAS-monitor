## SwitchBot CO2 -> GAS ダッシュボード

SwitchBot CO2 メーターの値を BLE で取得し、Google Apps Script（GAS）に送信して可視化するプロジェクトです。

現在はセキュリティ要件に合わせて、GASを次の2つに分離する前提です。

- **Ingest Webアプリ（公開）**: PythonからPOSTを受けて `rawdata` に追記
- **Dashboard Webアプリ（組織内限定）**: グラフ表示とデータ取得

## ファイル構成

- `main.py`: Python 側の収集・POST処理（既定5分ループ）
- `IngestCode.gs`: Ingest用GASコード（`doPost` + 必要ヘルパー）
- `DashboardCode.gs`: Dashboard用GASコード（`doGet`, `getReadings` + 必要ヘルパー）
- `Dashboard.html`: Dashboard用フロントエンド（Plotly描画）
- `Code.gs`: 旧・単一構成（ロールバック/参照用）
- `_.env`: 環境変数テンプレート

## Python セットアップ

1. 依存パッケージをインストール
2. `_.env` を `.env` にコピーして設定
   - `CO2_METER_BLE_MAC_ADDRESS`
   - `GAS_POST_URL`（Ingest Webアプリの `/exec`）
   - `GAS_POST_TOKEN`
   - 任意: `GAS_DASHBOARD_URL`（Dashboard URLの控え）
   - 必要に応じて時間系設定（`POLL_INTERVAL_SECONDS` など）
3. 実行

```bash
python main.py
```

## GAS セットアップ（分離構成）

### 1) 事前準備

1. Google スプレッドシートを作成
2. 保存先の Spreadsheet ID を控える

### 2) Ingest プロジェクト（POST受信専用）

1. 新規 Apps Script プロジェクトを作成（例: `SwitchBot CO2 Ingest`）
2. `IngestCode.gs` の内容を貼り付け
3. Script Properties を設定
   - `SPREADSHEET_ID` = 保存先スプレッドシートID
   - `SWITCHBOT_POST_TOKEN` = `.env` の `GAS_POST_TOKEN`
4. Webアプリとしてデプロイ
   - 実行ユーザー: **自分**
   - アクセス権: **全員（Anyone）**
5. `/exec` URL を `.env` の `GAS_POST_URL` に設定

### 3) Dashboard プロジェクト（表示専用）

1. 新規 Apps Script プロジェクトを作成（例: `SwitchBot CO2 Dashboard`）
2. `DashboardCode.gs` と `Dashboard.html` を貼り付け
3. Script Properties を設定
   - `SPREADSHEET_ID` = 保存先スプレッドシートID
4. Webアプリとしてデプロイ
   - 実行ユーザー: **自分**
   - アクセス権: **組織内ユーザー（Anyone within domain）**
5. `/exec` URL を組織内ユーザーに共有（任意で `GAS_DASHBOARD_URL` に記録）

## スプレッドシート形式

- シート名: `rawdata`
- ヘッダー:
  - `timestamp`
  - `temperature_c`
  - `humidity_pct`
  - `co2_ppm`

シートやヘッダーが無い場合は、スクリプト側で自動作成します。

## 動作確認チェックリスト

1. Ingest URL にPOSTし `{ "ok": true }` が返る
2. `rawdata` に1行追加される
3. Dashboard URL を組織内アカウントで開いてグラフ表示できる
4. 組織外/未ログインでDashboard URLにアクセスすると拒否される

## 効率化メモ

- Ingestの `doPost` は 1リクエスト1回の追記のみ
- Dashboardの `getReadings` は末尾ウィンドウ読み取り + 段階的拡張
- Dashboardの `getReadings` は `CacheService` による短期キャッシュを利用
