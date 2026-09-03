const SPREADSHEET_ID_PROPERTY = "SPREADSHEET_ID";
const SHEET_NAME = "expenses";
const EXPENSE_HEADERS = ["id", "date", "title", "category", "amount", "createdAt", "updatedAt"];
const WRITE_LOCK_TIMEOUT_MS = 10000;

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action !== "list") {
      throw new ApiError("INVALID_ACTION", "不正なactionです");
    }
    return jsonResponse({ success: true, data: listExpenses() });
  } catch (error) {
    return errorResponse(error);
  }
}

function doPost(e) {
  try {
    const request = parseRequestBody(e);

    if (request.action === "create") {
      return jsonResponse({ success: true, data: createExpense(request.expense) });
    }
    if (request.action === "update") {
      return jsonResponse({ success: true, data: updateExpense(request.expense) });
    }
    if (request.action === "delete") {
      return jsonResponse({ success: true, data: deleteExpense(request.id) });
    }

    throw new ApiError("INVALID_ACTION", "不正なactionです");
  } catch (error) {
    return errorResponse(error);
  }
}

// 初回の権限承認とシート準備に使用する
function setupExpensesSheet() {
  getExpensesSheet();
}

function getSpreadsheet() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  if (!spreadsheetId) {
    throw new ApiError("CONFIGURATION_ERROR", "スプレッドシートの設定を確認してください");
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new ApiError("CONFIGURATION_ERROR", "スプレッドシートの設定を確認してください");
  }
}

function getExpensesSheet() {
  const spreadsheet = getSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  ensureExpenseHeader(sheet);
  return sheet;
}

function ensureExpenseHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, EXPENSE_HEADERS.length).setValues([EXPENSE_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const currentHeaders = sheet.getRange(1, 1, 1, EXPENSE_HEADERS.length).getDisplayValues()[0];
  const isValidHeader = EXPENSE_HEADERS.every((header, index) => currentHeaders[index] === header);
  if (!isValidHeader) {
    throw new ApiError("SHEET_SCHEMA_ERROR", "expensesシートのヘッダー行を確認してください");
  }
}

function listExpenses() {
  const sheet = getExpensesSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  return sheet
    .getRange(2, 1, lastRow - 1, EXPENSE_HEADERS.length)
    .getValues()
    .filter((row) => String(row[0]).trim() !== "")
    .map(rowToExpense);
}

function createExpense(expense) {
  const cleanExpense = validateExpense(expense, false);

  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const now = new Date().toISOString();
    const createdExpense = {
      id: "expense-" + Utilities.getUuid(),
      date: cleanExpense.date,
      title: cleanExpense.title,
      category: cleanExpense.category,
      amount: cleanExpense.amount,
      createdAt: now,
      updatedAt: now,
    };

    writeExpenseRow(sheet, sheet.getLastRow() + 1, createdExpense);
    return createdExpense;
  });
}

function updateExpense(expense) {
  const cleanExpense = validateExpense(expense, true);

  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const rowNumber = findRowById(sheet, cleanExpense.id);
    if (rowNumber === -1) {
      throw new ApiError("NOT_FOUND", "更新対象の支出が見つかりません");
    }

    const currentExpense = rowToExpense(
      sheet.getRange(rowNumber, 1, 1, EXPENSE_HEADERS.length).getValues()[0],
    );
    const updatedExpense = {
      id: cleanExpense.id,
      date: cleanExpense.date,
      title: cleanExpense.title,
      category: cleanExpense.category,
      amount: cleanExpense.amount,
      createdAt: currentExpense.createdAt,
      updatedAt: new Date().toISOString(),
    };

    writeExpenseRow(sheet, rowNumber, updatedExpense);
    return updatedExpense;
  });
}

function deleteExpense(id) {
  const cleanId = validateId(id);

  return withWriteLock(function () {
    const sheet = getExpensesSheet();
    const rowNumber = findRowById(sheet, cleanId);
    if (rowNumber === -1) {
      throw new ApiError("NOT_FOUND", "削除対象の支出が見つかりません");
    }

    sheet.deleteRow(rowNumber);
    return { id: cleanId };
  });
}

function findRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  const index = ids.findIndex((row) => String(row[0]) === id);
  return index === -1 ? -1 : index + 2;
}

function validateExpense(expense, requiresId) {
  if (!expense || typeof expense !== "object") {
    throw new ApiError("VALIDATION_ERROR", "支出データを入力してください");
  }

  const id = requiresId ? validateId(expense.id) : "";
  const date = String(expense.date || "").trim();
  const title = String(expense.title || "").trim();
  const category = String(expense.category || "").trim();
  const amount = Number(expense.amount);

  if (!isRealDateString(date)) {
    throw new ApiError("VALIDATION_ERROR", "日付はYYYY-MM-DD形式の実在する日付で入力してください");
  }
  if (!title) {
    throw new ApiError("VALIDATION_ERROR", "店名または支出内容を入力してください");
  }
  if (title.length > 80) {
    throw new ApiError("VALIDATION_ERROR", "店名または支出内容は80文字以内で入力してください");
  }
  if (!category) {
    throw new ApiError("VALIDATION_ERROR", "カテゴリを入力してください");
  }
  if (category.length > 40) {
    throw new ApiError("VALIDATION_ERROR", "カテゴリは40文字以内で入力してください");
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw new ApiError("VALIDATION_ERROR", "金額は1円以上の整数で入力してください");
  }

  return { id: id, date: date, title: title, category: category, amount: amount };
}

function validateId(id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    throw new ApiError("VALIDATION_ERROR", "idを入力してください");
  }
  return cleanId;
}

function isRealDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function writeExpenseRow(sheet, rowNumber, expense) {
  // 日付と文字列列をプレーンテキストにし、数式として評価されないようにする
  sheet.getRange(rowNumber, 2, 1, 3).setNumberFormat("@");
  sheet.getRange(rowNumber, 6, 1, 2).setNumberFormat("@");
  sheet.getRange(rowNumber, 1, 1, EXPENSE_HEADERS.length).setValues([[
    expense.id,
    expense.date,
    protectSpreadsheetText(expense.title),
    protectSpreadsheetText(expense.category),
    expense.amount,
    expense.createdAt,
    expense.updatedAt,
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
    id: String(row[0]),
    date: normalizeDateCell(row[1]),
    title: restoreSpreadsheetText(row[2]),
    category: restoreSpreadsheetText(row[3]),
    amount: Number(row[4]),
    createdAt: normalizeTimestamp(row[5]),
    updatedAt: normalizeTimestamp(row[6]),
  };
}

function normalizeDateCell(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(value);
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

function parseRequestBody(e) {
  const contents = e && e.postData && e.postData.contents;
  if (!contents) {
    throw new ApiError("INVALID_JSON", "リクエスト本文がありません");
  }

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
    if (!locked) {
      throw new ApiError("LOCK_TIMEOUT", "処理が混み合っています。時間をおいて再試行してください");
    }
    return callback();
  } finally {
    if (locked) lock.releaseLock();
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(error) {
  if (error instanceof ApiError) {
    return jsonResponse({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }

  console.error(error && error.stack ? error.stack : error);
  return jsonResponse({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "サーバー内部でエラーが発生しました" },
  });
}
