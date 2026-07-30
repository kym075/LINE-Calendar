const STORAGE_KEY = "kakeiboExpenseRecords";

// 初回起動時のみ保存する初期データ
const initialExpenseRecords = [
  { id: "initial-1", date: "2026-07-01", title: "コンビニ", category: "食費", amount: 850, memo: "" },
  { id: "initial-2", date: "2026-07-01", title: "ドラッグストア", category: "日用品", amount: 1200, memo: "" },
  { id: "initial-3", date: "2026-07-03", title: "昼食", category: "食費", amount: 750, memo: "" },
  { id: "initial-4", date: "2026-07-03", title: "ガソリン", category: "交通費", amount: 3000, memo: "" },
  { id: "initial-5", date: "2026-07-08", title: "書店", category: "趣味", amount: 1500, memo: "" },
];

let expenseRecords = [];
let calendar = null;
let selectedDetailDate = "";
let lastFocusedElement = null;

const expenseModal = document.getElementById("expense-modal");
const formModal = document.getElementById("expense-form-modal");
const modalTitle = document.getElementById("modal-title");
const expenseList = document.getElementById("expense-list");
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
const expenseMemoInput = document.getElementById("expense-memo");

const numberFormatter = new Intl.NumberFormat("ja-JP");
const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

function formatYen(amount) {
  return `¥${numberFormatter.format(Number(amount))}`;
}

function createUniqueId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `expense-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isValidExpenseRecord(record) {
  return Boolean(
    record &&
      typeof record.id === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
      typeof record.title === "string" &&
      typeof record.category === "string" &&
      Number.isInteger(Number(record.amount)) &&
      Number(record.amount) >= 1,
  );
}

// 将来はこの関数内をAPI取得へ置き換える
function loadExpenseRecords() {
  const storedJson = localStorage.getItem(STORAGE_KEY);

  if (storedJson === null) {
    const initialRecords = initialExpenseRecords.map((record) => ({ ...record }));
    saveExpenseRecords(initialRecords);
    return initialRecords;
  }

  try {
    const storedRecords = JSON.parse(storedJson);
    if (!Array.isArray(storedRecords)) {
      throw new Error("保存データが配列ではありません。");
    }

    return storedRecords.filter(isValidExpenseRecord).map((record) => ({
      id: record.id,
      date: record.date,
      title: record.title,
      category: record.category,
      amount: Number(record.amount),
      memo: typeof record.memo === "string" ? record.memo : "",
    }));
  } catch (error) {
    console.error("保存済みの支出データを読み込めませんでした。", error);
    return [];
  }
}

function saveExpenseRecords(records = expenseRecords) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function addExpenseRecord(expenseData) {
  const newRecord = { id: createUniqueId(), ...expenseData };
  expenseRecords.push(newRecord);
  saveExpenseRecords();
  return newRecord;
}

function updateExpenseRecord(id, expenseData) {
  const index = expenseRecords.findIndex((record) => record.id === id);
  if (index === -1) return null;

  expenseRecords[index] = { id, ...expenseData };
  saveExpenseRecords();
  return expenseRecords[index];
}

function deleteExpenseRecord(id) {
  const previousLength = expenseRecords.length;
  expenseRecords = expenseRecords.filter((record) => record.id !== id);
  if (expenseRecords.length === previousLength) return false;

  saveExpenseRecords();
  return true;
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

  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus();
  }
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

  item.append(name, category, amount);

  if (record.memo) {
    const memo = document.createElement("p");
    memo.className = "expense-item__memo";
    memo.textContent = record.memo;
    item.append(memo);
  }

  const actions = document.createElement("div");
  actions.className = "expense-item__actions";
  actions.append(
    createActionButton("編集", "item-action", "edit", record.id),
    createActionButton("削除", "item-action item-action--delete", "delete", record.id),
  );
  item.append(actions);
  return item;
}

function renderExpenseDetails(dateString) {
  selectedDetailDate = dateString;
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
    expenseMemoInput.value = record.memo;
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
  const isWholeYen = Number.isInteger(amount) && amount >= 1;

  if (!expenseForm.checkValidity() || !isWholeYen) {
    formError.textContent = "必須項目を入力し、金額は1円以上の整数にしてください。";
    expenseForm.reportValidity();
    return null;
  }

  return {
    date: expenseDateInput.value,
    title: expenseTitleInput.value.trim(),
    category: expenseCategoryInput.value,
    amount,
    memo: expenseMemoInput.value.trim(),
  };
}

function handleFormSubmit(event) {
  event.preventDefault();
  const formData = getValidatedFormData();
  if (!formData || !formData.title) {
    if (!formData || !expenseTitleInput.value.trim()) {
      formError.textContent = "必須項目を入力し、金額は1円以上の整数にしてください。";
    }
    return;
  }

  const editingId = expenseIdInput.value;
  if (editingId) {
    updateExpenseRecord(editingId, formData);
  } else {
    addExpenseRecord(formData);
  }

  refreshCalendarEvents();
  closeModal(formModal);

  if (expenseModal.classList.contains("is-open")) {
    renderExpenseDetails(selectedDetailDate);
  } else {
    openExpenseModal(formData.date);
  }
}

function handleExpenseListClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) return;

  const record = expenseRecords.find((item) => item.id === actionButton.dataset.recordId);
  if (!record) return;

  if (actionButton.dataset.action === "edit") {
    openExpenseForm(record.date, record);
    return;
  }

  if (actionButton.dataset.action === "delete") {
    const confirmed = window.confirm(`「${record.title}」を削除しますか？`);
    if (!confirmed) return;

    deleteExpenseRecord(record.id);
    refreshCalendarEvents();
    renderExpenseDetails(selectedDetailDate);
  }
}

function hideCalendarLoading() {
  calendarLoading.classList.add("is-hidden");
  calendarLoading.setAttribute("aria-hidden", "true");
}

function showCalendarLoadingError() {
  calendarLoading.classList.add("has-error");
  calendarLoading.querySelector(".loading-message").textContent =
    "カレンダーを読み込めませんでした。ファイル一式を同じフォルダに保存して再読み込みしてください。";
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

// CDNを利用できないローカル表示環境では同梱ファイルへ切り替える
async function ensureFullCalendarLoaded() {
  if (!window.FullCalendar) {
    await loadLocalScript("vendor/fullcalendar-6.1.19.min.js");
  }

  if (!hasJapaneseCalendarLocale()) {
    await loadLocalScript("vendor/fullcalendar-ja-6.1.19.min.js");
  }

  return Boolean(window.FullCalendar);
}

async function initializeCalendar() {

  try {
    const isCalendarReady = await ensureFullCalendarLoaded();
    if (!isCalendarReady) {
      throw new Error("FullCalendarを読み込めませんでした。");
    }

    expenseRecords = loadExpenseRecords();
    calendar = new FullCalendar.Calendar(document.getElementById("calendar"), {
      locale: "ja",
      initialView: "dayGridMonth",
      initialDate: "2026-07-01",
      firstDay: 0,
      fixedWeekCount: false,
      showNonCurrentDates: true,
      dayMaxEvents: 1,
      height: "auto",
      headerToolbar: {
        left: "prev",
        center: "title",
        right: "today next",
      },
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
    console.error("カレンダーの初期化に失敗しました。", error);
    showCalendarLoadingError();
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
