const EXPENSE_SHEET_NAME = "expenses";
const MEMBER_SHEET_NAME = "members";
const EXPENSE_HEADERS = [
  "id", "householdId", "userId", "userName", "date",
  "title", "category", "amount", "createdAt", "updatedAt",
];
const LEGACY_EXPENSE_HEADERS = ["id", "date", "title", "category", "amount", "createdAt", "updatedAt"];
const MEMBER_HEADERS = ["userId", "householdId", "displayName", "joinedAt"];
const WRITE_LOCK_TIMEOUT_MS = 10000;

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function doGet() {
  return jsonResponse({ success: true, data: { status: "ok" } });
}

function doPost(e) {
  try {
    const request = parseRequestBody(e);
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
    const spreadsheet = getSpreadsheet();
    prepareExpensesSheet(spreadsheet);
    getOrCreateSheet(spreadsheet, MEMBER_SHEET_NAME, MEMBER_HEADERS);
    console.log("初期設定が完了しました");
  });
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
