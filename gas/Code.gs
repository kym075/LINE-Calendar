const EXPENSE_SHEET_NAME = "expenses";
const MEMBER_SHEET_NAME = "members";
const LINE_GROUP_SHEET_NAME = "lineGroups";
const RECEIPT_JOB_SHEET_NAME = "receiptJobs";
const EXPENSE_HEADERS = [
  "id", "householdId", "userId", "userName", "date",
  "title", "category", "amount", "createdAt", "updatedAt",
];
const LEGACY_EXPENSE_HEADERS = ["id", "date", "title", "category", "amount", "createdAt", "updatedAt"];
const MEMBER_HEADERS = ["userId", "householdId", "displayName", "joinedAt"];
const LINE_GROUP_HEADERS = ["groupId", "householdId", "linkedBy", "linkedAt"];
const RECEIPT_JOB_HEADERS = [
  "messageId", "householdId", "userId", "status",
  "expenseId", "errorCode", "createdAt", "updatedAt", "errorDetail",
];
const EXPENSE_CATEGORIES = ["食費", "日用品", "交通費", "趣味", "衣服", "医療", "その他"];
const WRITE_LOCK_TIMEOUT_MS = 10000;
const MAX_RECEIPT_IMAGE_BYTES = 10 * 1024 * 1024;

class ApiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail || "";
  }
}

function doGet() {
  return jsonResponse({ success: true, data: { status: "ok" } });
}

function doPost(e) {
  try {
    const request = parseRequestBody(e);

    // LINE Webhookは署名検証済みのWorkerからのみ受け付ける
    if (request.action === "lineWebhook") {
      return jsonResponse({ success: true, data: handleLineWebhook(request) });
    }

    const lineUser = verifyLineIdToken(request.idToken);

    if (request.action === "session") {
      return jsonResponse({ success: true, data: getSession(lineUser) });
    }
    if (request.action === "join") {
      return jsonResponse({ success: true, data: joinHousehold(lineUser, request.joinCode) });
    }

    const member = requireMember(lineUser.userId);
    if (request.action === "list") {
      return jsonResponse({ success: true, data: listExpenses(member.householdId) });
    }
    if (request.action === "create") {
      return jsonResponse({ success: true, data: createExpense(request.expense, member, lineUser) });
    }
    if (request.action === "update") {
      return jsonResponse({ success: true, data: updateExpense(request.expense, member.householdId) });
    }
    if (request.action === "delete") {
      return jsonResponse({ success: true, data: deleteExpense(request.id, member.householdId) });
    }

    throw new ApiError("INVALID_ACTION", "不正なactionです");
  } catch (error) {
    return errorResponse(error);
  }
}

// 初回設定と旧expensesシートの移行に使用する
function setupApplication() {
  return withWriteLock(function () {
    // 実際の値は「プロジェクトの設定」内のスクリプトプロパティから取得する
    getRequiredProperty("SPREADSHEET_ID");
    getRequiredProperty("LINE_CHANNEL_ID");
    getRequiredProperty("HOUSEHOLD_ID");
    getRequiredProperty("HOUSEHOLD_JOIN_CODE");
    getRequiredProperty("LINE_MESSAGING_CHANNEL_ACCESS_TOKEN");
    getRequiredProperty("LINE_WEBHOOK_SHARED_SECRET");
    getRequiredProperty("GEMINI_API_KEY");
    getRequiredProperty("GEMINI_MODEL");
    const spreadsheet = getSpreadsheet();
    prepareExpensesSheet(spreadsheet);
    getOrCreateSheet(spreadsheet, MEMBER_SHEET_NAME, MEMBER_HEADERS);
    getOrCreateSheet(spreadsheet, LINE_GROUP_SHEET_NAME, LINE_GROUP_HEADERS);
    prepareReceiptJobsSheet(spreadsheet);
    console.log("初期設定が完了しました");
  });
}

function handleLineWebhook(request) {
  const receivedSecret = String(request.webhookSecret || "");
  const expectedSecret = getRequiredProperty("LINE_WEBHOOK_SHARED_SECRET");
  if (!receivedSecret || receivedSecret !== expectedSecret) {
    throw new ApiError("AUTH_ERROR", "Webhookを認証できませんでした");
  }

  const webhook = request.webhook;
  const events = webhook && Array.isArray(webhook.events) ? webhook.events : [];
  events.forEach(processLineWebhookEvent);
  return { accepted: true, eventCount: events.length };
}

function processLineWebhookEvent(event) {
  if (!event || !event.replyToken) return;

  if (event.type === "join") {
    replyLineMessage(event.replyToken, "家計簿Botが参加しました。レシート画像の読み取り機能を準備中です。");
    return;
  }

  if (event.type !== "message" || !event.message) return;
  const source = event.source || {};
  const isGroupMessage = source.type === "group" && source.groupId && source.userId;

  if (
    event.message.type === "text"
    && String(event.message.text || "").trim() === "家計簿連携"
  ) {
    if (!isGroupMessage) {
      replyLineMessage(event.replyToken, "この操作は家計簿用グループ内で実行してください。");
      return;
    }
    const member = findMemberByUserId(String(source.userId));
    if (!member) {
      replyLineMessage(event.replyToken, "先に家計簿画面から共有家計簿へ参加してください。");
      return;
    }
    linkLineGroup(String(source.groupId), member);
    replyLineMessage(event.replyToken, "このグループを共有家計簿に連携しました。");
    return;
  }

  if (event.message.type === "image") {
    if (!isGroupMessage) {
      replyLineMessage(event.replyToken, "レシート画像は家計簿用グループへ送信してください。");
      return;
    }
    const linkedGroup = findLineGroupById(String(source.groupId));
    if (!linkedGroup) {
      replyLineMessage(event.replyToken, "先にグループ内で「家計簿連携」と送信してください。");
      return;
    }
    const sender = findMemberByUserId(String(source.userId));
    if (!sender || sender.householdId !== linkedGroup.householdId) {
      replyLineMessage(event.replyToken, "共有家計簿に参加しているメンバーのみ登録できます。");
      return;
    }
    processReceiptImage(event, sender);
    return;
  }
  if (event.message.type === "text" && String(event.message.text || "").trim() === "家計簿テスト") {
    replyLineMessage(event.replyToken, "Webhookを正常に受信できました。");
  }
}

function processReceiptImage(event, member) {
  const messageId = String(event.message.id || "").trim();
  if (!messageId) {
    replyLineMessage(event.replyToken, "画像を取得できませんでした。もう一度送信してください。");
    return;
  }
  if (!claimReceiptJob(messageId, member)) return;

  try {
    const image = fetchLineMessageImage(messageId);
    const analyzed = analyzeReceiptImage(image);
    const expenseInput = validateAnalyzedReceipt(analyzed);
    const expense = createExpense(expenseInput, member, {
      userId: member.userId,
      displayName: member.displayName,
    });
    try {
      finishReceiptJob(messageId, "completed", expense.id, "");
    } catch (error) {
      console.error("登録済みレシートの処理状態を更新できませんでした");
    }
    replyLineMessage(
      event.replyToken,
      expense.date + "\n" + expense.title + "\n" + expense.category + "  ¥" + formatInteger(expense.amount) + "\nを家計簿へ登録しました。",
    );
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    const errorDetail = error instanceof ApiError ? error.detail : String(error && error.message || error);
    safelyFailReceiptJob(messageId, errorCode, errorDetail);
    console.error("レシート処理に失敗しました。code=" + errorCode);
    replyLineMessage(event.replyToken, receiptErrorMessage(errorCode));
  }
}

function fetchLineMessageImage(messageId) {
  const token = getRequiredProperty("LINE_MESSAGING_CHANNEL_ACCESS_TOKEN");
  const response = UrlFetchApp.fetch(
    "https://api-data.line.me/v2/bot/message/" + encodeURIComponent(messageId) + "/content",
    {
      method: "get",
      headers: { Authorization: "Bearer " + token },
      muteHttpExceptions: true,
    },
  );
  if (response.getResponseCode() !== 200) {
    throw new ApiError("LINE_IMAGE_ERROR", "LINEから画像を取得できませんでした");
  }

  const blob = response.getBlob();
  const bytes = blob.getBytes();
  if (!bytes.length || bytes.length > MAX_RECEIPT_IMAGE_BYTES) {
    throw new ApiError("IMAGE_SIZE_ERROR", "画像サイズを確認してください");
  }
  const contentType = String(blob.getContentType() || "image/jpeg").toLowerCase();
  if (contentType.indexOf("image/") !== 0) {
    throw new ApiError("IMAGE_TYPE_ERROR", "画像形式を確認してください");
  }
  return { bytes: bytes, contentType: contentType };
}

function analyzeReceiptImage(image) {
  const apiKey = getRequiredProperty("GEMINI_API_KEY");
  const model = getRequiredProperty("GEMINI_MODEL");
  const fallbackModel = String(
    PropertiesService.getScriptProperties().getProperty("GEMINI_FALLBACK_MODEL") || "gemini-2.5-flash",
  ).trim();
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const prompt = [
    "日本の家計簿に登録するレシート画像を解析してください。",
    "最終的に実際に支払った合計額をamountにしてください。小計、お預り、釣銭は選ばないでください。",
    "titleは店名、dateはYYYY-MM-DD形式にしてください。年がない場合は現在日付に最も近い過去の日付を推定してください。",
    "categoryは食費、日用品、交通費、趣味、衣服、医療、その他のいずれかにしてください。",
    "必須項目を画像から判断できない場合はisReceiptをfalseにし、値を創作しないでください。",
    "現在の日本時間の日付は" + today + "です。",
  ].join("\n");
  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { mimeType: image.contentType, data: Utilities.base64Encode(image.bytes) } },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          isReceipt: { type: "BOOLEAN" },
          date: { type: "STRING" },
          title: { type: "STRING" },
          category: { type: "STRING", enum: EXPENSE_CATEGORIES },
          amount: { type: "INTEGER" },
        },
        required: ["isReceipt", "date", "title", "category", "amount"],
      },
    },
  };

  let response = fetchGeminiResponse(model, apiKey, payload);
  let responseCode = response.getResponseCode();

  // 一時的な混雑時は同じモデルを一度だけ再試行する
  if (responseCode === 503) {
    Utilities.sleep(1500);
    response = fetchGeminiResponse(model, apiKey, payload);
    responseCode = response.getResponseCode();
  }

  // 混雑または利用上限時は安定した別モデルへ切り替える
  if ((responseCode === 503 || responseCode === 429) && fallbackModel && fallbackModel !== model) {
    console.warn("Geminiモデルをフォールバックします: " + model + " -> " + fallbackModel);
    response = fetchGeminiResponse(fallbackModel, apiKey, payload);
    responseCode = response.getResponseCode();
  }

  if (responseCode !== 200) {
    const responseText = String(response.getContentText() || "").slice(0, 1500);
    console.error("Gemini APIエラー HTTP " + responseCode + ": " + responseText);
    throw new ApiError(
      getGeminiErrorCode(responseCode, responseText),
      "Geminiによる画像解析に失敗しました",
      getGeminiErrorDetail(responseCode, responseText),
    );
  }

  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new ApiError("GEMINI_RESPONSE_ERROR", "Geminiの応答を解析できませんでした");
  }
  const parts = body && body.candidates && body.candidates[0]
    && body.candidates[0].content && body.candidates[0].content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) throw new ApiError("GEMINI_RESPONSE_ERROR", "Geminiから解析結果を取得できませんでした");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError("GEMINI_RESPONSE_ERROR", "Geminiの解析結果がJSONではありません");
  }
}

function fetchGeminiResponse(model, apiKey, payload) {
  return UrlFetchApp.fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    },
  );
}

function getGeminiErrorCode(responseCode, responseText) {
  const detail = String(responseText || "").toUpperCase();
  if (detail.indexOf("API_KEY_INVALID") !== -1 || detail.indexOf("API KEY NOT VALID") !== -1) {
    return "GEMINI_AUTH_ERROR";
  }
  if (detail.indexOf("MODEL") !== -1 && detail.indexOf("NOT FOUND") !== -1) {
    return "GEMINI_MODEL_ERROR";
  }
  if (responseCode === 401 || responseCode === 403) return "GEMINI_AUTH_ERROR";
  if (responseCode === 404) return "GEMINI_MODEL_ERROR";
  if (responseCode === 429) return "GEMINI_RATE_LIMIT_ERROR";
  if (responseCode === 503) return "GEMINI_UNAVAILABLE_ERROR";
  if (responseCode === 400) return "GEMINI_REQUEST_ERROR";
  return "GEMINI_API_ERROR";
}

function getGeminiErrorDetail(responseCode, responseText) {
  let status = "";
  let message = String(responseText || "");
  try {
    const body = JSON.parse(message);
    status = String(body && body.error && body.error.status || "");
    message = String(body && body.error && body.error.message || message);
  } catch (error) {
    // JSONでない場合は応答本文をそのまま使用する
  }
  return ("HTTP " + responseCode + (status ? " " + status : "") + ": " + message).slice(0, 1000);
}

function validateAnalyzedReceipt(receipt) {
  if (!receipt || receipt.isReceipt !== true) {
    throw new ApiError("RECEIPT_NOT_RECOGNIZED", "レシートを認識できませんでした");
  }
  if (EXPENSE_CATEGORIES.indexOf(String(receipt.category || "")) === -1) {
    throw new ApiError("RECEIPT_VALIDATION_ERROR", "カテゴリを判定できませんでした");
  }
  try {
    return validateExpense({
      date: receipt.date,
      title: receipt.title,
      category: receipt.category,
      amount: Number(receipt.amount),
    }, false);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError("RECEIPT_VALIDATION_ERROR", "レシートの必須項目を確認できませんでした");
    }
    throw error;
  }
}

function getReceiptJobsSheet() {
  return prepareReceiptJobsSheet(getSpreadsheet());
}

function prepareReceiptJobsSheet(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(RECEIPT_JOB_SHEET_NAME) || spreadsheet.insertSheet(RECEIPT_JOB_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    ensureHeader(sheet, RECEIPT_JOB_HEADERS);
    return sheet;
  }
  const previousHeaders = RECEIPT_JOB_HEADERS.slice(0, 8);
  const currentHeaders = sheet.getRange(1, 1, 1, previousHeaders.length).getDisplayValues()[0];
  if (previousHeaders.every(function (header, index) { return currentHeaders[index] === header; })) {
    if (!sheet.getRange(1, 9).getDisplayValue()) sheet.getRange(1, 9).setValue("errorDetail");
  }
  ensureHeader(sheet, RECEIPT_JOB_HEADERS);
  return sheet;
}

function findReceiptJobRow(messageId) {
  const sheet = getReceiptJobsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  const index = ids.findIndex(function (row) { return String(row[0]) === messageId; });
  return index === -1 ? -1 : index + 2;
}

function claimReceiptJob(messageId, member) {
  return withWriteLock(function () {
    if (findReceiptJobRow(messageId) !== -1) return false;
    const now = new Date().toISOString();
    const sheet = getReceiptJobsSheet();
    const rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, RECEIPT_JOB_HEADERS.length).setNumberFormat("@");
    sheet.getRange(rowNumber, 1, 1, RECEIPT_JOB_HEADERS.length).setValues([[
      messageId, member.householdId, member.userId, "processing", "", "", now, now, "",
    ]]);
    return true;
  });
}

function finishReceiptJob(messageId, status, expenseId, errorCode, errorDetail) {
  return withWriteLock(function () {
    const sheet = getReceiptJobsSheet();
    const rowNumber = findReceiptJobRow(messageId);
    if (rowNumber === -1) return;
    sheet.getRange(rowNumber, 4, 1, 3).setValues([[
      status, expenseId || "", errorCode || "",
    ]]);
    sheet.getRange(rowNumber, 8).setValue(new Date().toISOString());
    sheet.getRange(rowNumber, 9).setValue(errorDetail || "");
  });
}

function safelyFailReceiptJob(messageId, errorCode, errorDetail) {
  try {
    finishReceiptJob(messageId, "failed", "", errorCode, errorDetail);
  } catch (error) {
    console.error("レシート処理状態の更新に失敗しました");
  }
}

function receiptErrorMessage(errorCode) {
  if (errorCode === "RECEIPT_NOT_RECOGNIZED" || errorCode === "RECEIPT_VALIDATION_ERROR") {
    return "レシートの店名・日付・合計を読み取れませんでした。明るい場所で全体を撮り直してください。";
  }
  if (errorCode === "IMAGE_SIZE_ERROR") {
    return "画像が大きすぎます。10MB以下の画像を送信してください。";
  }
  if (errorCode === "GEMINI_AUTH_ERROR") {
    return "Gemini APIの認証に失敗しました。APIキーの設定を確認してください。";
  }
  if (errorCode === "GEMINI_MODEL_ERROR") {
    return "設定されたGeminiモデルを利用できません。モデル名を確認してください。";
  }
  if (errorCode === "GEMINI_RATE_LIMIT_ERROR") {
    return "Gemini APIの利用上限に達しました。時間をおいてもう一度送信してください。";
  }
  if (errorCode === "GEMINI_UNAVAILABLE_ERROR") {
    return "Gemini APIが混み合っています。時間をおいてもう一度送信してください。";
  }
  if (errorCode === "GEMINI_REQUEST_ERROR") {
    return "Gemini APIへの送信内容に問題がありました。管理者が設定を確認してください。";
  }
  return "レシートの処理に失敗しました。時間をおいてもう一度送信してください。";
}

function formatInteger(value) {
  return String(Math.trunc(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function getLineGroupsSheet() {
  return getOrCreateSheet(getSpreadsheet(), LINE_GROUP_SHEET_NAME, LINE_GROUP_HEADERS);
}

function findLineGroupById(groupId) {
  const sheet = getLineGroupsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const rows = sheet.getRange(2, 1, lastRow - 1, LINE_GROUP_HEADERS.length).getValues();
  const row = rows.find(function (values) { return String(values[0]) === groupId; });
  if (!row) return null;
  return {
    groupId: String(row[0]), householdId: String(row[1]),
    linkedBy: String(row[2]), linkedAt: normalizeTimestamp(row[3]),
  };
}

function linkLineGroup(groupId, member) {
  return withWriteLock(function () {
    const existing = findLineGroupById(groupId);
    if (existing) {
      if (existing.householdId !== member.householdId) {
        throw new ApiError("GROUP_ALREADY_LINKED", "このグループは別の家計簿に連携されています");
      }
      return existing;
    }

    const linkedGroup = {
      groupId: groupId,
      householdId: member.householdId,
      linkedBy: member.userId,
      linkedAt: new Date().toISOString(),
    };
    const sheet = getLineGroupsSheet();
    const rowNumber = sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, LINE_GROUP_HEADERS.length).setNumberFormat("@");
    sheet.getRange(rowNumber, 1, 1, LINE_GROUP_HEADERS.length).setValues([[
      linkedGroup.groupId, linkedGroup.householdId, linkedGroup.linkedBy, linkedGroup.linkedAt,
    ]]);
    return linkedGroup;
  });
}

function replyLineMessage(replyToken, message) {
  try {
    const token = getRequiredProperty("LINE_MESSAGING_CHANNEL_ACCESS_TOKEN");
    const response = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: "text", text: message }],
      }),
      muteHttpExceptions: true,
    });

    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      console.error("LINEへの返信に失敗しました。status=" + status);
    }
  } catch (error) {
    console.error("LINEへの返信処理でエラーが発生しました");
  }
}

// 以前の手順との互換用
function setupExpensesSheet() {
  return setupApplication();
}

function getRequiredProperty(propertyName) {
  const value = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!value || !String(value).trim()) {
    throw new ApiError(
      "CONFIGURATION_ERROR",
      "スクリプトプロパティ「" + propertyName + "」が未設定です",
    );
  }
  return String(value).trim();
}

function getSpreadsheet() {
  try {
    return SpreadsheetApp.openById(getRequiredProperty("SPREADSHEET_ID"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("CONFIGURATION_ERROR", "スプレッドシートの設定を確認してください");
  }
}

function getExpensesSheet() {
  return getOrCreateSheet(getSpreadsheet(), EXPENSE_SHEET_NAME, EXPENSE_HEADERS);
}

function getMembersSheet() {
  return getOrCreateSheet(getSpreadsheet(), MEMBER_SHEET_NAME, MEMBER_HEADERS);
}

function getOrCreateSheet(spreadsheet, sheetName, headers) {
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  ensureHeader(sheet, headers);
  return sheet;
}

function ensureHeader(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }
  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (!headers.every(function (header, index) { return currentHeaders[index] === header; })) {
    throw new ApiError("SHEET_SCHEMA_ERROR", sheet.getName() + "シートのヘッダー行を確認してください");
  }
}

function prepareExpensesSheet(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(EXPENSE_SHEET_NAME) || spreadsheet.insertSheet(EXPENSE_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    ensureHeader(sheet, EXPENSE_HEADERS);
    return;
  }
  const currentNewHeaders = sheet.getRange(1, 1, 1, EXPENSE_HEADERS.length).getDisplayValues()[0];
  if (EXPENSE_HEADERS.every(function (header, index) { return currentNewHeaders[index] === header; })) return;

  const currentLegacyHeaders = sheet.getRange(1, 1, 1, LEGACY_EXPENSE_HEADERS.length).getDisplayValues()[0];
  const isLegacy = LEGACY_EXPENSE_HEADERS.every(function (header, index) {
    return currentLegacyHeaders[index] === header;
  });
  if (!isLegacy) throw new ApiError("SHEET_SCHEMA_ERROR", "expensesシートのヘッダー行を確認してください");

  const householdId = getRequiredProperty("HOUSEHOLD_ID");
  const lastRow = sheet.getLastRow();
  const legacyRows = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, LEGACY_EXPENSE_HEADERS.length).getValues();
  const migratedExpenses = legacyRows
    .filter(function (row) { return String(row[0]).trim() !== ""; })
    .map(function (row) {
      return {
        id: String(row[0]), householdId: householdId, userId: "legacy", userName: "移行データ",
        date: normalizeDateCell(row[1]), title: restoreSpreadsheetText(row[2]),
        category: restoreSpreadsheetText(row[3]), amount: Number(row[4]),
        createdAt: normalizeTimestamp(row[5]), updatedAt: normalizeTimestamp(row[6]),
      };
    });

  sheet.getDataRange().clearContent();
  sheet.getRange(1, 1, 1, EXPENSE_HEADERS.length).setValues([EXPENSE_HEADERS]);
  sheet.setFrozenRows(1);
  migratedExpenses.forEach(function (expense, index) {
    writeExpenseRow(sheet, index + 2, expense);
  });
}

function verifyLineIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) throw new ApiError("AUTH_REQUIRED", "LINE認証が必要です");

  const channelId = getRequiredProperty("LINE_CHANNEL_ID");
  let response;
  try {
    response = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: { id_token: token, client_id: channelId },
      muteHttpExceptions: true,
    });
  } catch (error) {
    throw new ApiError("AUTH_ERROR", "LINE認証を確認できませんでした");
  }
  if (response.getResponseCode() !== 200) {
    throw new ApiError("AUTH_ERROR", "LINE認証の有効期限または設定を確認してください");
  }

  let profile;
  try {
    profile = JSON.parse(response.getContentText());
  } catch (error) {
    throw new ApiError("AUTH_ERROR", "LINE認証を確認できませんでした");
  }
  if (!profile.sub || String(profile.aud) !== channelId) {
    throw new ApiError("AUTH_ERROR", "LINE認証を確認できませんでした");
  }
  return {
    userId: String(profile.sub),
    displayName: String(profile.name || "LINEユーザー").trim().slice(0, 80),
  };
}

function getSession(lineUser) {
  const member = findMemberByUserId(lineUser.userId);
  return {
    joined: Boolean(member),
    user: { displayName: lineUser.displayName, householdId: member ? member.householdId : "" },
  };
}

function joinHousehold(lineUser, joinCode) {
  const cleanCode = String(joinCode || "").trim();
  if (!cleanCode || cleanCode !== getRequiredProperty("HOUSEHOLD_JOIN_CODE")) {
    throw new ApiError("JOIN_CODE_INVALID", "共有コードが正しくありません");
  }
  return withWriteLock(function () {
    const existingMember = findMemberByUserId(lineUser.userId);
    if (existingMember) return getSession(lineUser);
    const sheet = getMembersSheet();
    const member = {
      userId: lineUser.userId,
      householdId: getRequiredProperty("HOUSEHOLD_ID"),
      displayName: lineUser.displayName,
      joinedAt: new Date().toISOString(),
    };
    writeMemberRow(sheet, sheet.getLastRow() + 1, member);
    return { joined: true, user: { displayName: lineUser.displayName, householdId: member.householdId } };
  });
}

function requireMember(userId) {
  const member = findMemberByUserId(userId);
  if (!member) throw new ApiError("USER_NOT_REGISTERED", "共有家計簿への参加が必要です");
  return member;
}

function findMemberByUserId(userId) {
  const sheet = getMembersSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const rows = sheet.getRange(2, 1, lastRow - 1, MEMBER_HEADERS.length).getValues();
  const row = rows.find(function (values) { return String(values[0]) === userId; });
  if (!row) return null;
  return {
    userId: String(row[0]), householdId: String(row[1]),
    displayName: restoreSpreadsheetText(row[2]), joinedAt: normalizeTimestamp(row[3]),
  };
}

function listExpenses(householdId) {
  const sheet = getExpensesSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, EXPENSE_HEADERS.length).getValues()
    .filter(function (row) { return String(row[0]).trim() !== "" && String(row[1]) === householdId; })
    .map(rowToExpense);
}

function createExpense(expense, member, lineUser) {
  const cleanExpense = validateExpense(expense, false);
  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const now = new Date().toISOString();
    const createdExpense = {
      id: "expense-" + Utilities.getUuid(), householdId: member.householdId,
      userId: member.userId, userName: lineUser.displayName,
      date: cleanExpense.date, title: cleanExpense.title, category: cleanExpense.category,
      amount: cleanExpense.amount, createdAt: now, updatedAt: now,
    };
    writeExpenseRow(sheet, sheet.getLastRow() + 1, createdExpense);
    return createdExpense;
  });
}

function updateExpense(expense, householdId) {
  const cleanExpense = validateExpense(expense, true);
  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const rowNumber = findExpenseRowById(sheet, cleanExpense.id, householdId);
    if (rowNumber === -1) throw new ApiError("NOT_FOUND", "更新対象の支出が見つかりません");
    const current = rowToExpense(sheet.getRange(rowNumber, 1, 1, EXPENSE_HEADERS.length).getValues()[0]);
    const updated = {
      id: current.id, householdId: current.householdId, userId: current.userId,
      userName: current.userName, date: cleanExpense.date, title: cleanExpense.title,
      category: cleanExpense.category, amount: cleanExpense.amount,
      createdAt: current.createdAt, updatedAt: new Date().toISOString(),
    };
    writeExpenseRow(sheet, rowNumber, updated);
    return updated;
  });
}

function deleteExpense(id, householdId) {
  const cleanId = validateId(id);
  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const rowNumber = findExpenseRowById(sheet, cleanId, householdId);
    if (rowNumber === -1) throw new ApiError("NOT_FOUND", "削除対象の支出が見つかりません");
    sheet.deleteRow(rowNumber);
    return { id: cleanId };
  });
}

function findExpenseRowById(sheet, id, householdId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const rows = sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues();
  const index = rows.findIndex(function (row) { return String(row[0]) === id && String(row[1]) === householdId; });
  return index === -1 ? -1 : index + 2;
}

function validateExpense(expense, requiresId) {
  if (!expense || typeof expense !== "object") throw new ApiError("VALIDATION_ERROR", "支出データを入力してください");
  const id = requiresId ? validateId(expense.id) : "";
  const date = String(expense.date || "").trim();
  const title = String(expense.title || "").trim();
  const category = String(expense.category || "").trim();
  const amount = Number(expense.amount);
  if (!isRealDateString(date)) throw new ApiError("VALIDATION_ERROR", "実在する日付を入力してください");
  if (!title) throw new ApiError("VALIDATION_ERROR", "店名または支出内容を入力してください");
  if (title.length > 80) throw new ApiError("VALIDATION_ERROR", "店名または支出内容は80文字以内で入力してください");
  if (!category) throw new ApiError("VALIDATION_ERROR", "カテゴリを入力してください");
  if (category.length > 40) throw new ApiError("VALIDATION_ERROR", "カテゴリは40文字以内で入力してください");
  if (!Number.isInteger(amount) || amount < 1) throw new ApiError("VALIDATION_ERROR", "金額は1円以上の整数で入力してください");
  return { id: id, date: date, title: title, category: category, amount: amount };
}

function validateId(id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) throw new ApiError("VALIDATION_ERROR", "idを入力してください");
  return cleanId;
}

function isRealDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function writeExpenseRow(sheet, rowNumber, expense) {
  sheet.getRange(rowNumber, 1, 1, EXPENSE_HEADERS.length).setNumberFormat("@");
  sheet.getRange(rowNumber, 8).setNumberFormat("0");
  sheet.getRange(rowNumber, 1, 1, EXPENSE_HEADERS.length).setValues([[
    expense.id, expense.householdId, expense.userId, protectSpreadsheetText(expense.userName),
    expense.date, protectSpreadsheetText(expense.title), protectSpreadsheetText(expense.category),
    expense.amount, expense.createdAt, expense.updatedAt,
  ]]);
}

function writeMemberRow(sheet, rowNumber, member) {
  sheet.getRange(rowNumber, 1, 1, MEMBER_HEADERS.length).setNumberFormat("@");
  sheet.getRange(rowNumber, 1, 1, MEMBER_HEADERS.length).setValues([[
    member.userId, member.householdId, protectSpreadsheetText(member.displayName), member.joinedAt,
  ]]);
}

function protectSpreadsheetText(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function restoreSpreadsheetText(value) {
  const text = String(value == null ? "" : value);
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

function rowToExpense(row) {
  return {
    id: String(row[0]), householdId: String(row[1]), userId: String(row[2]),
    userName: restoreSpreadsheetText(row[3]), date: normalizeDateCell(row[4]),
    title: restoreSpreadsheetText(row[5]), category: restoreSpreadsheetText(row[6]),
    amount: Number(row[7]), createdAt: normalizeTimestamp(row[8]), updatedAt: normalizeTimestamp(row[9]),
  };
}

function normalizeDateCell(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(value);
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

function parseRequestBody(e) {
  const contents = e && e.postData && e.postData.contents;
  if (!contents) throw new ApiError("INVALID_JSON", "リクエスト本文がありません");
  try {
    const request = JSON.parse(contents);
    if (!request || typeof request !== "object") throw new Error("invalid body");
    return request;
  } catch (error) {
    throw new ApiError("INVALID_JSON", "JSON形式のリクエスト本文を送信してください");
  }
}

function withWriteLock(callback) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(WRITE_LOCK_TIMEOUT_MS);
    if (!locked) throw new ApiError("LOCK_TIMEOUT", "処理が混み合っています。時間をおいて再試行してください");
    return callback();
  } finally {
    if (locked) lock.releaseLock();
  }
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({ success: false, error: { code: error.code, message: error.message } });
  }
  console.error(error && error.stack ? error.stack : error);
  return jsonResponse({ success: false, error: { code: "INTERNAL_ERROR", message: "サーバー内部でエラーが発生しました" } });
}
