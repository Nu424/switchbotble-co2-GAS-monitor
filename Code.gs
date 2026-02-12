/**
 * @fileoverview SwitchBot CO2ダッシュボード用のWebアプリバックエンド。
 * センサーデータを受信してスプレッドシートへ追記し、期間指定データを返却する。
 */

const RAWDATA_SHEET_NAME = "rawdata";
const CACHE_TTL_SECONDS = 90;

/**
 * ダッシュボード画面を返す。
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput} HTML出力。
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Dashboard")
    .setTitle("SwitchBot ダッシュボード")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0");
}

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
    const expectedToken = PropertiesService.getScriptProperties().getProperty("SWITCHBOT_POST_TOKEN") || "";

    if (!payload.token || payload.token !== expectedToken) {
      return jsonOutput_({ ok: false, error: "認証に失敗しました。" });
    }

    validatePayload_(payload);

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
 * プリセットまたはカスタム日時範囲で計測データを取得する。
 *
 * @param {{
 *   presetKey: (string|undefined),
 *   startIso: (string|undefined),
 *   endIso: (string|undefined)
 * }} params ダッシュボードクライアントからのパラメータ。
 * @returns {{
 *   timestamps: string[],
 *   temperature_c: number[],
 *   humidity_pct: number[],
 *   co2_ppm: number[]
 * }} 絞り込み済み時系列データ。
 */
function getReadings(params) {
  const request = params || {};
  const range = resolveTimeRange_(request);

  const sheet = getRawdataSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return emptySeries_();
  }

  const cacheKey = buildCacheKey_(request, lastRow);
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const firstDataRow = 2;
  let windowSize = estimateInitialWindowSize_(request.presetKey);
  let startRow = Math.max(firstDataRow, lastRow - windowSize + 1);

  let values = [];
  let readCount = 0;
  while (true) {
    readCount += 1;
    // I/O最小化: 基本となる読み取りはこの1回。
    values = sheet.getRange(startRow, 1, lastRow - startRow + 1, 4).getValues();

    if (values.length === 0 || startRow === firstDataRow) {
      break;
    }

    const oldestInWindow = toDate_(values[0][0]);
    if (!oldestInWindow || oldestInWindow <= range.start) {
      break;
    }

    if (readCount >= 3) {
      break;
    }

    windowSize *= 2;
    startRow = Math.max(firstDataRow, lastRow - windowSize + 1);
  }

  const result = filterRowsToSeries_(values, range.start, range.end);
  cache.put(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
  return result;
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
 * プリセットまたはカスタム指定から対象期間を解決する。
 *
 * @param {{presetKey:(string|undefined), startIso:(string|undefined), endIso:(string|undefined)}} request クライアント指定パラメータ。
 * @returns {{start:Date, end:Date}} 期間。
 */
function resolveTimeRange_(request) {
  const now = new Date();
  const end = request.endIso ? toDate_(request.endIso) : now;
  if (!end) {
    throw new Error("endIsoの形式が不正です。");
  }

  if (request.startIso) {
    const start = toDate_(request.startIso);
    if (!start) {
      throw new Error("startIsoの形式が不正です。");
    }
    if (start > end) {
      throw new Error("startIsoはendIso以前である必要があります。");
    }
    return { start, end };
  }

  const minutes = presetToMinutes_(request.presetKey || "1h");
  return { start: new Date(end.getTime() - minutes * 60 * 1000), end };
}

/**
 * プリセットキーを分数へ変換する。
 *
 * @param {string} presetKey 30m, 1h, 1d などのプリセットキー。
 * @returns {number} 対応する分数。
 */
function presetToMinutes_(presetKey) {
  const map = {
    "30m": 30,
    "1h": 60,
    "3h": 180,
    "6h": 360,
    "12h": 720,
    "1d": 1440,
    "3d": 4320,
    "1w": 10080,
    "1mo": 43200,
    "1y": 525600,
  };
  if (!map[presetKey]) {
    throw new Error("不正なpresetKeyです: " + presetKey);
  }
  return map[presetKey];
}

/**
 * プリセットから初期取得ウィンドウ行数を見積もる。
 *
 * @param {string|undefined} presetKey プリセットキー。
 * @returns {number} 末尾から最初に読む行数。
 */
function estimateInitialWindowSize_(presetKey) {
  const key = presetKey || "1h";
  const minutes = presetToMinutes_(key);
  // 5分ごと送信前提のため、1時間あたり約12行。
  const rows = Math.ceil((minutes / 5) * 1.4);
  return Math.max(rows, 24);
}

/**
 * 行データをメモリ上で絞り込み、グラフ描画用配列に変換する。
 *
 * @param {Array<Array<*>>} rows スプレッドシート行データ。
 * @param {Date} start 期間開始。
 * @param {Date} end 期間終了。
 * @returns {{timestamps:string[], temperature_c:number[], humidity_pct:number[], co2_ppm:number[]}} 時系列データ。
 */
function filterRowsToSeries_(rows, start, end) {
  const output = emptySeries_();

  rows.forEach((row) => {
    const ts = toDate_(row[0]);
    if (!ts || ts < start || ts > end) {
      return;
    }

    output.timestamps.push(formatTimestampForOutput_(ts));
    output.temperature_c.push(Number(row[1]));
    output.humidity_pct.push(Number(row[2]));
    output.co2_ppm.push(Number(row[3]));
  });

  return output;
}

/**
 * 表示用にタイムゾーン付き日時文字列へ変換する。
 *
 * @param {Date} dateValue 変換元のDate。
 * @returns {string} `yyyy-MM-dd'T'HH:mm:ss+09:00` 形式の文字列。
 */
function formatTimestampForOutput_(dateValue) {
  return Utilities.formatDate(
    dateValue,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd'T'HH:mm:ssXXX"
  );
}

/**
 * 空の時系列データを返す。
 *
 * @returns {{timestamps:string[], temperature_c:number[], humidity_pct:number[], co2_ppm:number[]}} 空配列を持つオブジェクト。
 */
function emptySeries_() {
  return {
    timestamps: [],
    temperature_c: [],
    humidity_pct: [],
    co2_ppm: [],
  };
}

/**
 * リクエスト内容と最終行番号からキャッシュキーを作る。
 *
 * @param {Object} request リクエストオブジェクト。
 * @param {number} lastRow シート最終行。
 * @returns {string} キャッシュキー。
 */
function buildCacheKey_(request, lastRow) {
  const preset = request.presetKey || "";
  const startIso = request.startIso || "";
  const endIso = request.endIso || "";
  return ["readings", preset, startIso, endIso, String(lastRow)].join(":");
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
