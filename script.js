// API未接続時に使用する支出データ
const dummyExpenseRecords = [
  { id: 1, date: "2026-07-01", description: "コンビニ", category: "食費", amount: 850 },
  { id: 2, date: "2026-07-01", description: "ドラッグストア", category: "日用品", amount: 1200 },
  { id: 3, date: "2026-07-03", description: "昼食", category: "食費", amount: 750 },
  { id: 4, date: "2026-07-03", description: "ガソリン", category: "交通費", amount: 3000 },
  { id: 5, date: "2026-07-08", description: "書店", category: "趣味", amount: 1500 },
];

let expenseRecords = [];

const modal = document.getElementById("expense-modal");
const modalTitle = document.getElementById("modal-title");
const expenseList = document.getElementById("expense-list");
const dailyTotalAmount = document.getElementById("daily-total-amount");
const calendarLoading = document.getElementById("calendar-loading");
let lastFocusedElement = null;

const numberFormatter = new Intl.NumberFormat("ja-JP");

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

function formatYen(amount) {
  return `¥${numberFormatter.format(amount)}`;
}

// 将来はこの関数内をfetch処理へ置き換える
async function loadExpenseRecords() {
  return dummyExpenseRecords;
}

function getExpensesByDate(dateString) {
  return expenseRecords.filter((record) => record.date === dateString);
}

function calculateExpenseTotal(records) {
  return records.reduce((total, record) => total + record.amount, 0);
}

function getDailyTotals(records) {
  return records.reduce((totals, record) => {
    totals[record.date] = (totals[record.date] ?? 0) + record.amount;
    return totals;
  }, {});
}

// FullCalendarへ渡す日別合計イベントを作成
function createCalendarEvents(records) {
  const dailyTotals = getDailyTotals(records);

  return Object.entries(dailyTotals).map(([date, total]) => ({
    id: `expense-${date}`,
    start: date,
    allDay: true,
    title: formatYen(total),
    extendedProps: { date },
  }));
}

function createExpenseItem(record) {
  const item = document.createElement("article");
  item.className = "expense-item";

  const name = document.createElement("span");
  name.className = "expense-item__name";
  name.textContent = record.description;

  const category = document.createElement("span");
  category.className = "expense-item__category";
  category.textContent = record.category;

  const amount = document.createElement("span");
  amount.className = "expense-item__amount";
  amount.textContent = formatYen(record.amount);

  item.append(name, category, amount);
  return item;
}

function openExpenseModal(dateString) {
  const records = getExpensesByDate(dateString);
  const total = calculateExpenseTotal(records);
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

  dailyTotalAmount.textContent = formatYen(total);
  lastFocusedElement = document.activeElement;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  modal.querySelector(".modal__close").focus();
}

function closeExpenseModal() {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");

  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus();
  }
}

function hideCalendarLoading() {
  calendarLoading.classList.add("is-hidden");
  calendarLoading.setAttribute("aria-hidden", "true");
}

function showCalendarLoadingError() {
  calendarLoading.classList.add("has-error");
  calendarLoading.querySelector(".loading-message").textContent =
    "カレンダーを読み込めませんでした。通信環境を確認して再読み込みしてください。";
}

async function initializeCalendar() {
  const calendarElement = document.getElementById("calendar");

  if (!window.FullCalendar) {
    showCalendarLoadingError();
    return;
  }

  try {
    expenseRecords = await loadExpenseRecords();

    const calendar = new FullCalendar.Calendar(calendarElement, {
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
      buttonText: {
        today: "今日",
      },
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

document.querySelectorAll("[data-modal-close]").forEach((element) => {
  element.addEventListener("click", closeExpenseModal);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modal.classList.contains("is-open")) {
    closeExpenseModal();
  }
});

document.addEventListener("DOMContentLoaded", initializeCalendar);
