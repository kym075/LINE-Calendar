const API_URL = "ここにGASのWebアプリURL";

let expenseRecords = [];
let calendar = null;
let selectedDetailDate = "";
let lastFocusedElement = null;
let isFormSubmitting = false;
const deletingExpenseIds = new Set();

const expenseModal = document.getElementById("expense-modal");
const formModal = document.getElementById("expense-form-modal");
const modalTitle = document.getElementById("modal-title");
const expenseList = document.getElementById("expense-list");
const detailError = document.getElementById("detail-error");
const dailyTotalAmount = document.getElementById("daily-total-amount");
const calendarLoading = document.getElementById("calendar-loading");
const expenseForm = document.getElementById("expense-form");
const formModalTitle = document.getElementById("form-modal-title");
const formSubmitButton = document.getElementById("form-submit-button");
const formError = document.getElementById("form-error");
const expenseIdInput = document.getElementById("expense-id");
const expenseDateInput = document.getElementById("expense-date");
const expenseTitleInput = document.getElementById("expense-title");
const expenseCategoryInput = document.getElementById("expense-category");
const expenseAmountInput = document.getElementById("expense-amount");

const numberFormatter = new Intl.NumberFormat("ja-JP");
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

class ApiRequestError extends Error {
  constructor(kind, message, code = "") {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.code = code;
  }
}

function formatYen(amount) {
  return `¥${numberFormatter.format(Number(amount))}`;
}

function isApiConfigured() {
  return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(API_URL);
}

function normalizeExpenseRecord(record) {
  const amount = Number(record?.amount);
  const isValid =
    record &&
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
    typeof record.title === "string" &&
    typeof record.category === "string" &&
    Number.isInteger(amount) &&
    amount >= 1;

  if (!isValid) {
    throw new ApiRequestError("json", "APIレスポンスの支出データ形式が正しくありません。");
  }

  return {
    id: record.id,
    date: record.date,
    title: record.title,
    category: record.category,
    amount,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

async function requestApi(action, payload = null) {
  if (!isApiConfigured()) {
    throw new ApiRequestError("config", "GASのWebアプリURLが設定されていません。");
  }

  const requestUrl = new URL(API_URL);
  const options = {};

  if (payload === null) {
    requestUrl.searchParams.set("action", action);
  } else {
    options.method = "POST";
    // 不要なカスタムヘッダーを付けず、プリフライトを避ける
    options.body = JSON.stringify({ action, ...payload });
  }

  let response;
  try {
    response = await fetch(requestUrl.toString(), options);
  } catch (error) {
    throw new ApiRequestError("network", "GAS APIへ接続できませんでした。", "NETWORK_ERROR");
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new ApiRequestError("network", "APIレスポンスを受信できませんでした。", "NETWORK_ERROR");
  }

  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch (error) {
    throw new ApiRequestError("json", "APIレスポンスをJSONとして解析できませんでした。", "INVALID_JSON_RESPONSE");
  }

  if (!response.ok) {
    throw new ApiRequestError("server", "サーバーからエラーが返されました。", String(response.status));
  }

  if (!responseBody || typeof responseBody.success !== "boolean") {
    throw new ApiRequestError("json", "APIレスポンスの形式が正しくありません。", "INVALID_RESPONSE");
  }

  if (!responseBody.success) {
    const code = String(responseBody.error?.code || "API_ERROR");
    const message = String(responseBody.error?.message || "API処理に失敗しました。");
    const serverCodes = ["INTERNAL_ERROR", "CONFIGURATION_ERROR", "SHEET_SCHEMA_ERROR", "LOCK_TIMEOUT"];
    throw new ApiRequestError(serverCodes.includes(code) ? "server" : "api", message, code);
  }

  return responseBody.data;
}

function getUserErrorMessage(error) {
  console.error(error);

  if (!(error instanceof ApiRequestError)) {
    return "処理に失敗しました。時間をおいて再試行してください。";
  }

  if (error.kind === "config") {
    return "GASのWebアプリURLが未設定です。script.jsのAPI_URLを設定してください。";
  }
  if (error.kind === "network") {
    return "通信できませんでした。ネットワーク接続とGASの公開設定を確認してください。";
  }
  if (error.kind === "json") {
    return "サーバーの応答を読み取れませんでした。GASのデプロイ設定を確認してください。";
  }
  if (error.kind === "server") {
    return "サーバー内部でエラーが発生しました。時間をおいて再試行してください。";
  }

  return error.message;
}

async function loadExpenseRecords() {
  const records = await requestApi("list");
  if (!Array.isArray(records)) {
    throw new ApiRequestError("json", "支出一覧が配列ではありません。", "INVALID_RESPONSE");
  }
  return records.map(normalizeExpenseRecord);
}

async function addExpenseRecord(expenseData) {
  const createdRecord = normalizeExpenseRecord(
    await requestApi("create", { expense: expenseData }),
  );
  expenseRecords.push(createdRecord);
  return createdRecord;
}

async function updateExpenseRecord(id, expenseData) {
  const updatedRecord = normalizeExpenseRecord(
    await requestApi("update", { expense: { id, ...expenseData } }),
  );
  const index = expenseRecords.findIndex((record) => record.id === id);
  if (index !== -1) expenseRecords[index] = updatedRecord;
  return updatedRecord;
}

async function deleteExpenseRecord(id) {
  const result = await requestApi("delete", { id });
  if (!result || result.id !== id) {
    throw new ApiRequestError("json", "削除結果の形式が正しくありません。", "INVALID_RESPONSE");
  }
  expenseRecords = expenseRecords.filter((record) => record.id !== id);
}

function getExpensesByDate(dateString) {
  return expenseRecords.filter((record) => record.date === dateString);
}

function calculateExpenseTotal(records) {
  return records.reduce((total, record) => total + Number(record.amount), 0);
}

function getDailyTotals(records) {
  return records.reduce((totals, record) => {
    totals[record.date] = (totals[record.date] ?? 0) + Number(record.amount);
    return totals;
  }, {});
}

function createCalendarEvents(records) {
  return Object.entries(getDailyTotals(records)).map(([date, total]) => ({
    id: `expense-${date}`,
    start: date,
    allDay: true,
    title: formatYen(total),
    extendedProps: { date },
  }));
}

function refreshCalendarEvents() {
  if (!calendar) return;
  calendar.removeAllEvents();
  calendar.addEventSource(createCalendarEvents(expenseRecords));
}

function openModal(modalElement) {
  lastFocusedElement = document.activeElement;
  modalElement.classList.add("is-open");
  modalElement.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  modalElement.querySelector(".modal__close").focus();
}

function closeModal(modalElement) {
  modalElement.classList.remove("is-open");
  modalElement.setAttribute("aria-hidden", "true");

  if (!document.querySelector(".modal.is-open")) {
    document.body.classList.remove("modal-open");
  }

  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
}

function createActionButton(label, className, action, recordId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.recordId = recordId;
  return button;
}

function createExpenseItem(record) {
  const item = document.createElement("article");
  item.className = "expense-item";

  const name = document.createElement("span");
  name.className = "expense-item__name";
  name.textContent = record.title;

  const category = document.createElement("span");
  category.className = "expense-item__category";
  category.textContent = record.category;

  const amount = document.createElement("span");
  amount.className = "expense-item__amount";
  amount.textContent = formatYen(record.amount);

  const actions = document.createElement("div");
  actions.className = "expense-item__actions";
  actions.append(
    createActionButton("編集", "item-action", "edit", record.id),
    createActionButton("削除", "item-action item-action--delete", "delete", record.id),
  );

  item.append(name, category, amount, actions);
  return item;
}

function renderExpenseDetails(dateString) {
  selectedDetailDate = dateString;
  detailError.textContent = "";
  const records = getExpensesByDate(dateString);
  const localDate = new Date(`${dateString}T00:00:00`);

  modalTitle.textContent = dateFormatter.format(localDate);
  expenseList.replaceChildren();

  if (records.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "empty-message";
    emptyMessage.textContent = "この日の支出はありません";
    expenseList.append(emptyMessage);
  } else {
    records.forEach((record) => expenseList.append(createExpenseItem(record)));
  }

  dailyTotalAmount.textContent = formatYen(calculateExpenseTotal(records));
}

function openExpenseModal(dateString) {
  renderExpenseDetails(dateString);
  openModal(expenseModal);
}

function openExpenseForm(dateString, record = null) {
  expenseForm.reset();
  formError.textContent = "";

  if (record) {
    formModalTitle.textContent = "支出を編集";
    formSubmitButton.textContent = "更新する";
    expenseIdInput.value = record.id;
    expenseDateInput.value = record.date;
    expenseTitleInput.value = record.title;
    expenseCategoryInput.value = record.category;
    expenseAmountInput.value = String(record.amount);
  } else {
    formModalTitle.textContent = "支出を追加";
    formSubmitButton.textContent = "登録する";
    expenseIdInput.value = "";
    expenseDateInput.value = dateString;
  }

  openModal(formModal);
  expenseTitleInput.focus();
}

function getValidatedFormData() {
  const amount = Number(expenseAmountInput.value);
  const title = expenseTitleInput.value.trim();
  const category = expenseCategoryInput.value.trim();

  if (!expenseForm.checkValidity() || !title || !category || !Number.isInteger(amount) || amount < 1) {
    formError.textContent = "必須項目を入力し、金額は1円以上の整数にしてください。";
    expenseForm.reportValidity();
    return null;
  }

  return { date: expenseDateInput.value, title, category, amount };
}

function setFormSubmitting(isSubmitting) {
  isFormSubmitting = isSubmitting;
  formSubmitButton.disabled = isSubmitting;
  formSubmitButton.textContent = isSubmitting
    ? "保存中…"
    : expenseIdInput.value
      ? "更新する"
      : "登録する";
}

async function handleFormSubmit(event) {
  event.preventDefault();
  if (isFormSubmitting) return;

  const formData = getValidatedFormData();
  if (!formData) return;

  const editingId = expenseIdInput.value;
  formError.textContent = "";
  setFormSubmitting(true);

  try {
    if (editingId) {
      await updateExpenseRecord(editingId, formData);
    } else {
      await addExpenseRecord(formData);
    }

    refreshCalendarEvents();
    closeModal(formModal);
    renderExpenseDetails(selectedDetailDate || formData.date);
  } catch (error) {
    formError.textContent = getUserErrorMessage(error);
  } finally {
    setFormSubmitting(false);
  }
}

async function handleExpenseListClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) return;

  const record = expenseRecords.find((item) => item.id === actionButton.dataset.recordId);
  if (!record) return;

  if (actionButton.dataset.action === "edit") {
    openExpenseForm(record.date, record);
    return;
  }

  if (actionButton.dataset.action !== "delete" || deletingExpenseIds.has(record.id)) return;
  if (!window.confirm(`「${record.title}」を削除しますか？`)) return;

  deletingExpenseIds.add(record.id);
  detailError.textContent = "";
  actionButton.disabled = true;
  actionButton.textContent = "削除中…";

  try {
    await deleteExpenseRecord(record.id);
    refreshCalendarEvents();
    renderExpenseDetails(selectedDetailDate);
  } catch (error) {
    detailError.textContent = getUserErrorMessage(error);
    actionButton.disabled = false;
    actionButton.textContent = "削除";
  } finally {
    deletingExpenseIds.delete(record.id);
  }
}

function hideCalendarLoading() {
  calendarLoading.classList.add("is-hidden");
  calendarLoading.setAttribute("aria-hidden", "true");
}

function showCalendarLoadingError(message) {
  calendarLoading.classList.add("has-error");
  calendarLoading.querySelector(".loading-message").textContent = message;
}

function loadLocalScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${source}を読み込めませんでした。`));
    document.head.append(script);
  });
}

function hasJapaneseCalendarLocale() {
  return window.FullCalendar?.globalLocales?.some((locale) => locale.code === "ja");
}

// CDNを利用できない環境では同梱ファイルへ切り替える
async function ensureFullCalendarLoaded() {
  if (!window.FullCalendar) await loadLocalScript("vendor/fullcalendar-6.1.19.min.js");
  if (!hasJapaneseCalendarLocale()) await loadLocalScript("vendor/fullcalendar-ja-6.1.19.min.js");
  return Boolean(window.FullCalendar);
}

async function initializeCalendar() {
  try {
    if (!(await ensureFullCalendarLoaded())) {
      throw new Error("FullCalendarを読み込めませんでした。");
    }

    expenseRecords = await loadExpenseRecords();
    calendar = new FullCalendar.Calendar(document.getElementById("calendar"), {
      locale: "ja",
      initialView: "dayGridMonth",
      firstDay: 0,
      fixedWeekCount: false,
      showNonCurrentDates: true,
      dayMaxEvents: 1,
      height: "auto",
      headerToolbar: { left: "prev", center: "title", right: "today next" },
      buttonText: { today: "今日" },
      events: createCalendarEvents(expenseRecords),
      eventContent(eventInfo) {
        const amount = document.createElement("span");
        amount.className = "expense-amount";
        amount.textContent = eventInfo.event.title;
        return { domNodes: [amount] };
      },
      dateClick(dateInfo) {
        openExpenseModal(dateInfo.dateStr);
      },
      eventClick(eventInfo) {
        eventInfo.jsEvent.preventDefault();
        openExpenseModal(eventInfo.event.extendedProps.date);
      },
    });

    calendar.render();
    requestAnimationFrame(hideCalendarLoading);
  } catch (error) {
    const message = error instanceof ApiRequestError
      ? getUserErrorMessage(error)
      : "カレンダーを読み込めませんでした。ファイル一式を確認してください。";
    if (!(error instanceof ApiRequestError)) console.error(error);
    showCalendarLoadingError(message);
  }
}

document.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-modal]");
  if (!closeButton) return;
  const modalElement = document.getElementById(closeButton.dataset.closeModal);
  if (modalElement) closeModal(modalElement);
});

document.getElementById("add-from-detail").addEventListener("click", () =>
  openExpenseForm(selectedDetailDate),
);
expenseForm.addEventListener("submit", handleFormSubmit);
expenseList.addEventListener("click", handleExpenseListClick);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (formModal.classList.contains("is-open")) closeModal(formModal);
  else if (expenseModal.classList.contains("is-open")) closeModal(expenseModal);
});

document.addEventListener("DOMContentLoaded", initializeCalendar);
