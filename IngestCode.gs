/**
 * @fileoverview SwitchBot CO2 Ingest Webアプリ。
 * PythonクライアントからのPOSTを受け取り、rawdataシートへ追記する。
 *
 * 想定デプロイ:
 * - Webアプリ
 * - 実行ユーザー: 自分
 * - アクセス権: 全員 (Anyone)
 */

const RAWDATA_SHEET_NAME = "rawdata";

/**
 * 計測値を受信してrawdataシートに追記する。
 * このエンドポイントは次のJSONボディを想定する:
 * {
 *   "token": "...",
 *   "timestamp": "ISO8601文字列",
 *   "temperature_c": number,
 *   "humidity_pct": number,
 *   "co2_ppm": number
 * }
 *
 * @param {GoogleAppsScript.Events.DoPost} e POSTイベントオブジェクト。
 * @returns {GoogleAppsScript.Content.TextOutput} JSONレスポンス。
 */
function doPost(e) {
  try {
    const payload = parseJsonBody_(e);
    // ---入力を検証する
    const expectedToken = PropertiesService.getScriptProperties().getProperty("SWITCHBOT_POST_TOKEN") || "";

    if (!payload.token || payload.token !== expectedToken) {
      return jsonOutput_({ ok: false, error: "認証に失敗しました。" });
    }

    validatePayload_(payload);

    // ---シートにデータを追加する
    const sheet = getRawdataSheet_();
    // I/O最小化: 1リクエストにつき書き込みは1回のみ。
    sheet.appendRow([
      payload.timestamp,
      Number(payload.temperature_c),
      Number(payload.humidity_pct),
      Number(payload.co2_ppm),
    ]);

    return jsonOutput_({ ok: true });
  } catch (error) {
    return jsonOutput_({
      ok: false,
      error: "リクエストが不正です。",
      message: String(error),
    });
  }
}

/**
 * JSONのPOSTボディを解析する。
 *
 * @param {GoogleAppsScript.Events.DoPost} e POSTイベントオブジェクト。
 * @returns {Object} 解析済みJSONオブジェクト。
 */
function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("POSTボディが存在しません。");
  }
  return JSON.parse(e.postData.contents);
}

/**
 * 必須ペイロード項目を検証する。
 *
 * @param {Object} payload JSONペイロード。
 */
function validatePayload_(payload) {
  const requiredFields = ["timestamp", "temperature_c", "humidity_pct", "co2_ppm"];
  requiredFields.forEach((field) => {
    if (payload[field] === null || payload[field] === undefined || payload[field] === "") {
      throw new Error("必須項目が不足しています: " + field);
    }
  });

  if (!toDate_(payload.timestamp)) {
    throw new Error("timestampの形式が不正です。");
  }
}

/**
 * オブジェクトをJSONレスポンスへ変換する。
 *
 * @param {Object} payload レスポンスオブジェクト。
 * @returns {GoogleAppsScript.Content.TextOutput} テキスト出力。
 */
function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/**
 * rawdataシートを取得する。
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} rawdataシート。
 */
function getRawdataSheet_() {
  const scriptProps = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProps.getProperty("SPREADSHEET_ID");

  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();

  // ---シートを取得し、存在しなかったら作成する
  let sheet = spreadsheet.getSheetByName(RAWDATA_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RAWDATA_SHEET_NAME);
    sheet.appendRow(["timestamp", "temperature_c", "humidity_pct", "co2_ppm"]);
  }
  return sheet;
}

/**
 * スプレッドシート値を安全にDateへ変換する。
 *
 * @param {*} value スプレッドシートのセル値または日付文字列。
 * @returns {(Date|null)} 変換結果のDate。失敗時はnull。
 */
function toDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}
