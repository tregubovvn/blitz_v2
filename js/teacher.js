'use strict';

/* =====================================================================
   Блиц-опрос — панель преподавателя.
   Открывается ТОЛЬКО по прямой ссылке …/blitz/teacher.html; первая
   страница (index.html) — вход только для студентов.

   — Первая страница панели: создание комнаты + СТАТИСТИКА завершённых
     тестов (дата, название темы, просмотр результатов каждого теста).
   — Каждая комната работает ровно на ОДИН тест; после завершения
     результаты всех студентов сохраняются в общую статистику,
     комната закрывается и УДАЛЯЕТСЯ — войти в неё снова нельзя,
     пока преподаватель не создаст её заново.
   — Название темы преподаватель указывает в панели комнаты
     (по умолчанию «Тестирование студентов»).
   — Вопросы преподаватель НЕ пишет: выбирает только ТИП раунда.
     Раунд открывается прямо в карточке комнаты, показываются только
     реально поступившие ответы, кнопка «Нет правильного ответа»
     доступна в любом режиме.
   — Кнопки «Следующий раунд» нет: после выбора правильного ответа
     очки пересчитываются (анимация ~5 секунд), затем все автоматически
     возвращаются в режим ожидания следующего вопроса.
   — Очки за вопрос (актуальные правила): верный ответ
     S = 10 · M(n) + B, где n — длина серии включая текущий ответ
     (n≤3 → ×1, 4–6 → ×2, ≥7 → ×3), B — бонус за скорость +4…+8
     по доле оставшегося времени; неверный — −7 (серия обнуляется);
     «Пропустить вопрос» — −3 (серия сохраняется); таймаут — −3
     (серия обнуляется).
   — Таблица результатов показывается ВСЕГДА: между раундами, в панели
     раунда и в финальном экране.
   ===================================================================== */

const $ = function (id) { return document.getElementById(id); };

let room = null;
let auth = null;               // 'Basic ...' если задан пароль учителя
let state = null;              // содержимое rooms/{room}.json
let students = {};             // sid -> {name}
const seenStudents = new Map();// файл -> sid (чтобы уметь удалять)
const seenAnswerFiles = new Set();
let answersByRound = {};       // номер раунда -> sid -> {name, answer, elapsed, bonus}
let screen = 'stats';
let roundBoxOn = false;        // встроенная панель раунда показана
let pollInt = null;
let roundTimerInt = null;
let curRound = 0;
let judged = false;            // раунд уже проверен
let judging = false;           // идёт запись проверки (защита от двойного клика)
let lastJudgedKey = null;      // отмеченный правильный ответ
let lastJudgedTitle = '';
let lastResults = null;
let statsCache = null;
let recalcInt = null;          // таймер анимации пересчёта итогов
const RECALC_MS = 5000;        // пауза после проверки раунда
const RING_C = 326.73;         // длина окружности таймера (r=52)

/* ---------------- переключение экранов ---------------- */

function show(sec) {
  ['sec-stats', 'sec-create', 'sec-lobby', 'sec-final'].forEach(function (s) {
    $(s).classList.add('hidden');
  });
  $(sec).classList.remove('hidden');
  /* Главная страница = статистика + форма «Создать комнату» вместе */
  if (sec === 'sec-stats') $('sec-create').classList.remove('hidden');
  screen = sec.replace('sec-', '');
}

/* Панель раунда открывается ВНУТРИ карточки комнаты (без отдельного окна):
   на время раунда прячем кнопки запуска. */
function showRound(on) {
  roundBoxOn = on;
  $('round-box').classList.toggle('hidden', !on);
  $('start-area').classList.toggle('hidden', on);
  $('lobby-table-wrap').classList.toggle('hidden',
    on || !(lastResults && Object.keys(lastResults.scores || {}).length));
}

/* Анимация пересчёта итогов после проверки раунда (5 секунд),
   затем автоматический возврат всех в режим ожидания вопроса. */
function runRecalcCountdown() {
  $('recalc').classList.remove('hidden');
  const fill = $('recalc-fill');
  fill.style.width = '0%';
  const t0 = Date.now();
  clearInterval(recalcInt);
  recalcInt = setInterval(function () {
    const p = Math.min(1, (Date.now() - t0) / RECALC_MS);
    fill.style.width = (p * 100).toFixed(1) + '%';
    if (p >= 1) {
      clearInterval(recalcInt);
      $('recalc').classList.add('hidden');
      finishRoundPause();
    }
  }, 100);
}

async function finishRoundPause() {
  try {
    state.status = 'lobby';
    await apiPut('rooms/' + room + '.json', state, auth);
  } catch (e) { /* повторим при следующем действии */ }
  backToLobby();
}

function setConn(ok) {
  $('conn').classList.toggle('on', ok);
  $('conn-text').textContent = ok ? 'связь с сервером есть' : 'нет связи с сервером';
}

function setRing(pct, low) {
  $('ring-fg').style.strokeDashoffset = (RING_C * (1 - pct)).toFixed(1);
  $('ring-wrap').classList.toggle('low', !!low);
}

/* ---------------- статистика (первый экран) ---------------- */

async function loadStats() {
  const list = $('stats-list');
  list.textContent = '';
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'Загрузка…';
  list.appendChild(p);
  try {
    statsCache = await apiGet('stats.json', auth);
    setConn(true);
  } catch (e) {
    setConn(false);
    list.textContent = '';
    p.textContent = 'Не удалось загрузить статистику: ' + e.message;
    list.appendChild(p);
    return;
  }
  renderStats();
}

function renderStats() {
  const list = $('stats-list');
  list.textContent = '';
  const arr = Array.isArray(statsCache) ? statsCache : [];
  if (!arr.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Пока нет завершённых тестов. Создайте комнату — после завершения теста результаты появятся здесь.';
    list.appendChild(p);
    return;
  }
  arr.slice().reverse().forEach(function (rec) {
    const d = new Date(rec.date);
    const ds = isNaN(d.getTime()) ? String(rec.date)
      : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const recEl = document.createElement('div');
    recEl.className = 'rec';

    const head = document.createElement('div');
    head.className = 'rec-head';
    const dt = document.createElement('span');
    dt.className = 'rec-date';
    dt.textContent = ds;
    const tp = document.createElement('span');
    tp.className = 'rec-topic';
    tp.textContent = rec.topic || 'Тестирование студентов';
    const meta = document.createElement('span');
    meta.className = 'rec-meta';
    [['комната ' + (rec.room || '—')], [(rec.students || []).length + ' студ.'],
     [(rec.rounds || 0) + ' раунд(ов)'], ['просмотреть ▾']].forEach(function (m) {
      const c = document.createElement('i');
      c.className = 'mini';
      c.textContent = m[0];
      meta.appendChild(c);
    });
    head.append(dt, tp, meta);

    const body = document.createElement('div');
    body.className = 'rec-body hidden';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Место</th><th>Студент</th><th>Очки</th><th>Серия</th>' +
      '<th>Верно</th><th>Неверно</th><th>Пропуски</th><th>Время</th><th>Балл</th><th>Группа</th></tr></thead>';
    const tb = document.createElement('tbody');
    fillResultsTable(tb, rec.students || [], true);
    table.appendChild(tb);
    body.appendChild(table);

    head.addEventListener('click', function () { body.classList.toggle('hidden'); });
    recEl.append(head, body);
    list.appendChild(recEl);
  });
}

/* Заполнение таблицы результатов строками
   {name, points, correct, wrong, skip, streak, time, score, group} */
function fillResultsTable(tb, rows, fromStats) {
  tb.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'muted';
    td.textContent = 'Нет данных.';
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  rows.forEach(function (r, i) {
    const tr = document.createElement('tr');
    if (r.place <= 3) tr.className = 'top' + r.place;

    const tdP = document.createElement('td');
    const pl = document.createElement('span');
    pl.className = 'place' + (r.place <= 3 ? ' m' + r.place : '');
    pl.textContent = r.place || (i + 1);
    tdP.appendChild(pl);
    tr.appendChild(tdP);

    [r.name,
     String(r.points != null ? r.points : 0),
     String(r.streak || 0),
     String(r.correct || 0),
     String(r.wrong || 0),
     String(r.skip || 0),
     fmtTime(r.time),
     String(r.score)]
      .forEach(function (v) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });

    const tdG = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'chip g' + ((r.group || 0) + 1);
    chip.textContent = GROUP_NAMES[r.group || 0];
    tdG.appendChild(chip);
    tr.appendChild(tdG);
    tb.appendChild(tr);
  });
}

/* Полная таблица результатов в произвольный контейнер (всегда видна) */
function renderTableInto(boxId, rows) {
  const box = $(boxId);
  box.textContent = '';
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Место</th><th>Студент</th><th>Очки</th><th>Серия</th>' +
    '<th>Верно</th><th>Неверно</th><th>Пропуски</th><th>Время</th><th>Балл</th><th>Группа</th></tr></thead>';
  const tb = document.createElement('tbody');
  fillResultsTable(tb, rows || [], false);
  table.appendChild(tb);
  box.appendChild(table);
}

/* ---------------- создание комнаты ---------------- */

$('btn-open').addEventListener('click', createRoom);

async function createRoom() {
  const wanted = safeRoom($('room-id').value);
  const pass = $('teacher-pass').value.trim();
  auth = pass ? 'Basic ' + btoa('teacher:' + pass) : null;
  $('btn-open').disabled = true;
  try {
    await syncClock();
    let st = null;
    if (wanted) {
      st = await apiGet('rooms/' + wanted + '.json', auth);
      if (st && st.status === 'done') {
        alert('Комната ' + wanted + ' уже использована для теста.\nКаждая комната работает только на один тест — введите другой код.');
        $('btn-open').disabled = false;
        return;
      }
      room = wanted;
    } else {
      do { room = randomRoom(); st = await apiGet('rooms/' + room + '.json', auth); }
      while (st); // автокод ищем, пока не попадём на свободный
    }
    if (!st) {
      state = { status: 'lobby', round: 0, topic: 'Тестирование студентов', created: new Date().toISOString() };
      await apiPut('rooms/' + room + '.json', state, auth);
    } else {
      state = st; // возобновляем незавершённую комнату
    }
    $('room-id').value = '';
    localStorage.setItem('blitz_teach_room', room);
    enterLobby();
  } catch (e) {
    alert('Не удалось создать комнату: ' + e.message +
      '\nПроверьте настройки сервера: ' + API_BASE);
  }
  $('btn-open').disabled = false;
}

function enterLobby() {
  $('lobby-room').textContent = room;
  $('in-topic').value = (state && state.topic) || 'Тестирование студентов';
  show('sec-lobby');
  clearInterval(roundTimerInt);
  clearInterval(pollInt);
  pollInt = setInterval(tick, 1200);
  showRound(false);
  renderLobby();
  tick();
}

/* Автовозобновление: если панель случайно закрыли посреди теста */
(async function initTeacher() {
  show('sec-stats');
  loadStats();
  const saved = localStorage.getItem('blitz_teach_room');
  if (!saved) return;
  try {
    await syncClock();
    const st = await apiGet('rooms/' + saved + '.json', auth);
    if (st && st.status !== 'done') {
      room = saved;
      state = st;
      curRound = st.round || 0;
      if (st.status === 'judge') {
        judged = true;
        lastJudgedKey = (st.lastCorrect == null) ? null : st.lastCorrect;
        lastJudgedTitle = lastJudgedKey ? String(lastJudgedKey) : '';
      }
      enterLobby();
      if (st.status === 'active' || st.status === 'judge') enterRound();
      // раунд уже был проверен: проверяем, что кнопки заблокированы,
      // и завершаем паузу пересчёта (автовозврат в режим ожидания)
      if (st.status === 'judge') { judged = true; runRecalcCountdown(); }
    } else {
      localStorage.removeItem('blitz_teach_room');
    }
  } catch (e) { /* нет связи — остаёмся на статистике */ }
})();

/* ---------------- тема теста ---------------- */

$('in-topic').addEventListener('change', async function () {
  if (!state) return;
  const v = $('in-topic').value.trim().slice(0, 120);
  state.topic = v || 'Тестирование студентов';
  $('in-topic').value = state.topic;
  try { await apiPut('rooms/' + room + '.json', state, auth); } catch (e) { /* повторим позже */ }
});

/* ---------------- фоновый опрос ---------------- */

async function tick() {
  try {
    syncClock();
    const st = await apiGet('rooms/' + room + '.json', auth);
    setConn(true);
    if (st) state = st;
    if (!state) return;
    await pollStudents();
    if (screen === 'lobby') {
      try { lastResults = await apiGet('results/' + room + '.json', auth); }
      catch (e) { /* оставляем предыдущие данные */ }
      if (state.status === 'active') {
        if (state.round !== curRound) enterRound();
        await pollAnswers(state.round);
        showRound(true);
        renderRound();
      } else if (state.status === 'judge') {
        curRound = state.round;
        await pollAnswers(state.round);
        showRound(true);
        renderRound();
      } else {                               // lobby — между раундами
        if (roundBoxOn && !judged) showRound(false);
        renderLobby();
      }
    }
  } catch (e) {
    setConn(false);
  }
}

async function pollStudents() {
  let files;
  try { files = await apiList('students/' + room); } catch (e) { return; }
  for (const f of files) {
    if (seenStudents.has(f)) continue;
    try {
      const d = await apiGet('students/' + room + '/' + f);
      const sid = f.replace(/\.json$/, '');
      if (d && d.name) {
        students[d.sid || sid] = { name: d.name };
        seenStudents.set(f, d.sid || sid);
      }
    } catch (e) { /* пропускаем битый файл */ }
  }
}

async function pollAnswers(n) {
  let files;
  try { files = await apiList('answers/' + room); } catch (e) { return; }
  const pref = 'r' + n + '_';
  for (const f of files) {
    if (!f.startsWith(pref) || seenAnswerFiles.has(f)) continue;
    seenAnswerFiles.add(f);
    try {
      const d = await apiGet('answers/' + room + '/' + f);
      const sid = f.slice(pref.length, -5);
      if (d) {
        answersByRound[n] = answersByRound[n] || {};
        answersByRound[n][sid] = {
          name: d.name || sid,
          answer: d.answer,
          elapsed: +d.elapsed || 0,
          skip: !!d.skip
        };
      }
    } catch (e) { /* пропускаем битый файл */ }
  }
}

/* ---------------- лобби: студенты, тема, ссылка ---------------- */

function initials(n) {
  return n.split(' ').filter(Boolean).slice(0, 2)
    .map(function (w) { return w[0].toUpperCase(); }).join('');
}

function renderStudents() {
  const box = $('stu-chips');
  box.textContent = '';
  const entries = Object.keys(students).map(function (sid) {
    return { sid: sid, name: students[sid].name };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  $('stu-count').textContent = entries.length;
  entries.forEach(function (e) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stu-chip';
    chip.title = 'Удалить ' + e.name + ' из комнаты';
    const av = document.createElement('i');
    av.className = 'avatar';
    av.textContent = initials(e.name);
    const nm = document.createElement('span');
    nm.textContent = e.name;
    const x = document.createElement('i');
    x.className = 'x';
    x.textContent = '×';
    chip.append(av, nm, x);
    chip.addEventListener('click', function () { deleteStudent(e.sid); });
    box.appendChild(chip);
  });
}

async function deleteStudent(sid) {
  if (!students[sid]) return;
  if (!confirm('Удалить студента «' + students[sid].name + '» из комнаты?')) return;
  try {
    await apiDelete('students/' + room + '/' + sid + '.json', auth);
  } catch (e) { /* файла могло уже не быть */ }
  delete students[sid];
  seenStudents.delete(sid + '.json');
  if (lastResults && lastResults.scores && lastResults.scores[sid]) {
    delete lastResults.scores[sid];
    try { await apiPut('results/' + room + '.json', lastResults, auth); } catch (e) { /* не критично */ }
  }
  renderStudents();
}

$('btn-del-all').addEventListener('click', async function () {
  const sids = Object.keys(students);
  if (!sids.length) { alert('В комнате нет студентов.'); return; }
  if (!confirm('Удалить ВСЕХ студентов (' + sids.length + ') из комнаты?')) return;
  for (const sid of sids) {
    try {
      await apiDelete('students/' + room + '/' + sid + '.json', auth);
    } catch (e) { /* пропускаем */ }
    delete students[sid];
    seenStudents.delete(sid + '.json');
  }
  if (lastResults && lastResults.scores) {
    Object.keys(lastResults.scores).forEach(function (sid) {
      if (!students[sid]) delete lastResults.scores[sid];
    });
    try { await apiPut('results/' + room + '.json', lastResults, auth); } catch (e) { /* не критично */ }
  }
  renderStudents();
});

function renderLobby() {
  $('lobby-room').textContent = room;
  const base = location.href.replace(/teacher\.html.*$/, '');
  $('stu-link').value = base + 'index.html#' + room;
  renderStudents();
  // таблица результатов видна ВСЕГДА (обновляется после каждого раунда)
  const rows = lastResults ? rankFromScores(lastResults.scores) : [];
  const wrap = $('lobby-table-wrap');
  if (rows.length) {
    wrap.classList.remove('hidden');
    renderTableInto('lobby-table', rows);
  } else {
    wrap.classList.add('hidden');
  }
  showRound(roundBoxOn);
  $('btn-finish').disabled = !(lastResults && Object.keys(lastResults.scores || {}).length > 0);
}

$('btn-copy').addEventListener('click', async function () {
  const inp = $('stu-link');
  try {
    await navigator.clipboard.writeText(inp.value);
  } catch (e) {
    inp.select();
    try { document.execCommand('copy'); } catch (e2) { /* вручную */ }
  }
  $('btn-copy').textContent = 'Скопировано';
  setTimeout(function () { $('btn-copy').textContent = 'Копировать'; }, 1500);
});

/* ---------------- раунды ---------------- */

$('btn-choice').addEventListener('click', function () { startRound('choice'); });
$('btn-text').addEventListener('click', function () { startRound('text'); });

async function startRound(type) {
  const duration = type === 'choice' ? CHOICE_SECONDS : TEXT_SECONDS;
  const next = (state.round || 0) + 1;
  const st = {
    status: 'active',
    round: next,
    type: type,
    duration: duration,
    topic: state.topic || 'Тестирование студентов',
    startedAt: serverNow(),
    lastCorrect: null
  };
  try {
    await apiPut('rooms/' + room + '.json', st, auth);
    state = st;
    answersByRound[next] = {};
    enterRound();
  } catch (e) {
    alert('Не удалось запустить раунд: ' + e.message);
  }
}

function enterRound() {
  curRound = state.round;
  judged = false;
  judging = false;
  lastJudgedKey = null;
  lastJudgedTitle = '';
  $('recalc').classList.add('hidden');
  show('sec-lobby');          // экран не меняем — раунд внутри карточки комнаты
  showRound(true);
  renderRound();
  clearInterval(roundTimerInt);
  roundTimerInt = setInterval(function () {
    if (screen === 'lobby' && roundBoxOn) renderTimer();
  }, 200);
}

function renderTimer() {
  if (!state) return;
  if (state.status === 'active') {
    const rem = Math.max(0, (state.startedAt + state.duration * 1000 - serverNow()) / 1000);
    $('t-num').textContent = Math.ceil(rem);
    setRing(Math.max(0, Math.min(1, rem / state.duration)), rem < state.duration * 0.25);
  } else {                       // раунд закрыт — время вышло
    $('t-num').textContent = '0';
    setRing(0, false);
  }
}

function choiceIndex(label) {
  const n = parseInt(String(label).split('.')[0], 10);
  return isNaN(n) ? 99 : n;
}

function renderRound() {
  const isChoice = state.type === 'choice';
  $('round-title').textContent = 'Раунд ' + curRound + ' — ' +
    (isChoice ? 'выбор варианта (20 сек)' : 'ввод текста (40 сек)');
  renderTimer();

  const ans = answersByRound[curRound] || {};
  const box = $('answers');
  box.textContent = '';
  // только реально поступившие ответы студентов, которые есть в комнате;
  // намеренные пропуски (skip) в списке вариантов не показываются —
  // они учтутся автоматически (−3 очка, серия сохраняется)
  const list = Object.keys(ans).filter(function (sid) { return students[sid] && !ans[sid].skip; })
    .map(function (sid) { return ans[sid]; });

  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Ответов пока нет…';
    box.appendChild(p);
  }

  if (isChoice) {
    const groups = {};
    list.forEach(function (a) {
      const k = String(a.answer);
      if (!groups[k]) groups[k] = { title: k, names: [] };
      groups[k].names.push(a.name);
    });
    Object.keys(groups).sort(function (a, b) {
      const d = groups[b].names.length - groups[a].names.length;
      if (d !== 0) return d;
      return choiceIndex(a) - choiceIndex(b);
    }).forEach(function (k) {
      box.appendChild(answerGroupEl('Вариант ' + groups[k].title, groups[k].names, function () {
        judge(k, groups[k].title);
      }));
    });
  } else {
    // текстовые ответы: нижний регистр + объединение опечаток
    // (расстояние Дамерау—Левенштейна, порог схожести 0.80)
    textCluster(list.map(function (a) { return { answer: a.answer, name: a.name }; }))
      .sort(function (a, b) { return b.count - a.count; })
      .forEach(function (c) {
        box.appendChild(answerGroupEl('«' + c.title + '»', c.names, function () {
          judge(c.key, c.title);
        }));
      });
  }

  $('judged-note').textContent = judged
    ? (lastJudgedKey
        ? 'Правильный ответ отмечен: ' + (isChoice ? lastJudgedTitle : '«' + lastJudgedTitle + '»')
        : 'Раунд закрыт без правильного ответа.')
    : '';
  // кнопка «Нет правильного ответа» доступна в любом режиме (варианты и текст),
  // пока раунд не проверен
  $('btn-skip').disabled = judged;
  // таблица результатов — всегда под ответами
  const rows = lastResults ? rankFromScores(lastResults.scores) : [];
  const wrap = $('round-table-wrap');
  if (rows.length) {
    wrap.classList.remove('hidden');
    renderTableInto('round-table', rows);
  } else {
    wrap.classList.add('hidden');
  }
}

function answerGroupEl(title, names, onOk) {
  const div = document.createElement('div');
  div.className = 'answerGroup';
  const head = document.createElement('div');
  head.className = 'head';
  const ansEl = document.createElement('span');
  ansEl.className = 'ans';
  ansEl.textContent = title;
  const cnt = document.createElement('span');
  cnt.className = 'chip';
  cnt.textContent = names.length;
  const btn = document.createElement('button');
  btn.className = 'success';
  btn.textContent = 'Это правильный ответ';
  btn.disabled = judged;
  btn.addEventListener('click', onOk);
  head.append(ansEl, cnt, btn);
  const nm = document.createElement('div');
  nm.className = 'names';
  nm.textContent = names.join(', ');
  div.append(head, nm);
  return div;
}

/* ---------------- проверка раунда и подсчёт очков ----------------
   Очки ведутся в results/{room}.json (scores[sid]):
   {name, points, correct, wrong, skip, streak, time}.
   Актуальные правила за вопрос:
   — верный ответ: S = 10 · M(n) + B, где n — длина серии ВКЛЮЧАЯ
     текущий верный ответ (n≤3 → ×1, 4≤n≤6 → ×2, n≥7 → ×3),
     B — бонус за скорость от +4 до +8 по доле оставшегося времени;
   — неверный ответ: S = −7, серия сбрасывается (n = 0);
   — пропуск (кнопка студента): S = −3, серия СОХРАНЯЕТСЯ;
   — таймаут / нет ответа: S = −3, серия сбрасывается.
   «Нет правильного ответа» (кнопка преподавателя): ответившие
   считаются ошибившимися (−7, серия сброс), пропустившие — как пропуск. */

async function closeRound(correctKey) {
  const res = (await apiGet('results/' + room + '.json', auth)) ||
    { rounds: [], scores: {}, finished: false };
  const n = state.round;
  const dur = state.duration;
  const ansAll = answersByRound[n] || {};

  Object.keys(students).forEach(function (sid) {
    if (!res.scores[sid]) {
      res.scores[sid] = { name: students[sid].name, points: 0, correct: 0, wrong: 0, skip: 0, streak: 0, time: 0 };
    }
  });
  // студенты, удалённые из комнаты, исчезают из результатов
  Object.keys(res.scores).forEach(function (sid) {
    if (!students[sid]) delete res.scores[sid];
  });

  for (const sid of Object.keys(res.scores)) {
    const s = res.scores[sid];
    if (students[sid]) s.name = students[sid].name;
    s.streak = +s.streak || 0;
    const a = ansAll[sid];

    if (a && a.skip) {
      // намеренный пропуск: −3 очка, серия сохраняется, время учтено
      s.time += Math.min(+a.elapsed || 0, dur + GRACE_SECONDS);
      s.points = (s.points || 0) + S_SKIP;
      s.skip = (s.skip || 0) + 1;
    } else if (a) {
      // реальный ответ
      s.time += Math.min(+a.elapsed || 0, dur + GRACE_SECONDS);
      const hit = correctKey != null && (state.type === 'choice'
        ? String(a.answer) === String(correctKey)
        : isSimilarText(normText(a.answer), correctKey));
      if (hit) {
        s.correct++;
        s.streak++;                       // серия включает текущий ответ
        const earn = S_CORRECT * streakMult(s.streak) + speedBonus(a.elapsed, dur);
        s.points = (s.points || 0) + earn;
      } else {
        s.wrong++;
        s.streak = 0;                     // серия сбрасывается
        s.points = (s.points || 0) + S_WRONG;
      }
    } else {
      // таймаут / нет ответа: −3 очка, серия сбрасывается
      s.time += dur + MISS_PENALTY_SEC;
      s.streak = 0;
      s.points = (s.points || 0) + S_TIMEOUT;
    }
  }

  const meta = { n: n, type: state.type, duration: dur, correctKey: correctKey };
  const rt = res.rounds.find(function (r) { return r.n === n; });
  if (rt) Object.assign(rt, meta); else res.rounds.push(meta);
  res.updated = new Date().toISOString();
  await apiPut('results/' + room + '.json', res, auth);
  lastResults = res;
  return res;
}

async function judge(key, title) {
  if (judged || judging) return;
  const isChoice = state.type === 'choice';
  if (!confirm('Отметить как правильный: ' +
    (isChoice ? ('вариант ' + title) : ('«' + title + '»')) + '?\n' +
    'Очки будут пересчитаны, затем все вернутся в режим ожидания.')) return;
  judging = true;
  try {
    const normKey = isChoice ? key : normText(title);
    await closeRound(normKey);
    lastJudgedKey = normKey;
    lastJudgedTitle = title;
    judged = true;
    state.status = 'judge';
    state.lastCorrect = normKey;
    await apiPut('rooms/' + room + '.json', state, auth);
    renderRound();
    // анимация пересчёта ~5 секунд, затем автоматический возврат
    // в режим ожидания — кнопка «Следующий раунд» не нужна
    runRecalcCountdown();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
  judging = false;
}

$('btn-skip').addEventListener('click', async function () {
  if (judged || judging) return;
  if (!confirm('Закрыть раунд без правильного ответа?\n' +
    'Ответившие получат −7 очков (серия сбросится), пропустившие — −3 (серия сохранится).')) return;
  judging = true;
  try {
    await closeRound(null);
    lastJudgedKey = null;
    lastJudgedTitle = '';
    judged = true;
    state.status = 'judge';
    state.lastCorrect = null;
    await apiPut('rooms/' + room + '.json', state, auth);
    renderRound();
    runRecalcCountdown();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
  judging = false;
});

function backToLobby() {
  clearInterval(roundTimerInt);
  judged = false;
  judging = false;
  lastJudgedKey = null;
  lastJudgedTitle = '';
  show('sec-lobby');
  showRound(false);
  renderLobby();
}

/* ---------------- завершение теста ----------------
   Каждая комната работает только на ОДИН тест: после завершения
   результаты всех студентов сохраняются в общую статистику (stats.json),
   студенты получают свой итоговый балл и место (через standings в
   состоянии комнаты), затем комната УДАЛЯЕТСЯ — войти в неё снова
   нельзя, пока преподаватель не создаст её заново. */

$('btn-finish').addEventListener('click', finish);

async function finish() {
  if (!confirm('Завершить тест? Результаты будут сохранены в статистику,\n' +
    'студенты получат свои баллы и места, комната будет закрыта и удалена.')) return;
  const r = room; // фиксируем код: после завершения комната удаляется
  try {
    const res = lastResults || (await apiGet('results/' + r + '.json', auth)) ||
      { rounds: [], scores: {} };
    res.finished = true;
    res.topic = state.topic || 'Тестирование студентов';
    res.finishedAt = new Date().toISOString();
    res.standings = rankFromScores(res.scores || {});
    res.updated = res.finishedAt;
    await apiPut('results/' + r + '.json', res, auth);
    lastResults = res;

    // запись в общую статистику
    let stats = null;
    try { stats = await apiGet('stats.json', auth); } catch (e) { /* ещё нет файла */ }
    if (!Array.isArray(stats)) stats = [];
    stats.push({
      date: res.finishedAt,
      topic: res.topic,
      room: r,
      rounds: (res.rounds || []).length,
      students: res.standings.map(function (row) {
        return {
          name: row.name, points: row.points, correct: row.correct, wrong: row.wrong,
          skip: row.skip || 0, streak: row.streak || 0,
          time: Math.round(row.time), score: row.score, place: row.place, group: row.group
        };
      })
    });
    await apiPut('stats.json', stats, auth);

    // статус done + итоговая таблица: каждый студент прочитает свой
    // балл, место и группу (вход в комнату после этого закрыт)
    state.status = 'done';
    state.standings = res.standings.map(function (row) {
      return {
        sid: row.sid, name: row.name, points: row.points, correct: row.correct,
        wrong: row.wrong, skip: row.skip || 0, streak: row.streak || 0,
        time: Math.round(row.time), score: row.score, place: row.place, group: row.group
      };
    });
    await apiPut('rooms/' + r + '.json', state, auth);

    localStorage.removeItem('blitz_teach_room');
    renderFinal();
    show('sec-final');

    // даём студентам ~10 секунд прочитать итоги, затем удаляем все
    // данные комнаты: войти в неё снова будет нельзя до нового создания
    setTimeout(function () { cleanupRoom(r); }, 10000);
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

/* Полное удаление данных комнаты: профили студентов, ответы, бонусы
   ( legacy), результаты и сам файл комнаты. */
async function cleanupRoom(r) {
  const rm = function (p) { return apiDelete(p, auth).catch(function () { /* нет файла — ок */ }); };
  try {
    const stu = await apiList('students/' + r);
    for (const f of stu) await rm('students/' + r + '/' + f);
  } catch (e) { /* нет каталога — ок */ }
  try {
    const ans = await apiList('answers/' + r);
    for (const f of ans) await rm('answers/' + r + '/' + f);
  } catch (e) { /* нет каталога — ок */ }
  try {
    const bo = await apiList('bonuses/' + r);
    for (const f of bo) await rm('bonuses/' + r + '/' + f);
  } catch (e) { /* нет каталога — ок */ }
  await rm('results/' + r + '.json');
  await rm('rooms/' + r + '.json'); // после этого вход в комнату невозможен
}

function renderFinal() {
  $('final-topic').textContent = 'Тема: «' + ((state && state.topic) || 'Тестирование студентов') +
    '» · комната ' + room + ' · раундов: ' +
    ((lastResults && lastResults.rounds) ? lastResults.rounds.length : 0);
  // полная итоговая таблица результатов
  const rows = lastResults ? rankFromScores(lastResults.scores) : [];
  renderTableInto('final-table', rows);
}

$('btn-csv').addEventListener('click', function () {
  const rows = lastResults ? rankFromScores(lastResults.scores) : [];
  if (!rows.length) return;
  const head = ['Место', 'Студент', 'Очки', 'Серия', 'Верно', 'Неверно', 'Пропуски', 'Время (с)', 'Балл', 'Группа'];
  const lines = [head.join(';')].concat(rows.map(function (r) {
    return [r.place, r.name, r.points, r.streak || 0, r.correct, r.wrong, r.skip || 0,
      Math.round(r.time), r.score, GROUP_NAMES[r.group]].join(';');
  }));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'blitz-' + room + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

/* Новая комната — новый код и чистый тест (старая комната остаётся
   закрытой, её результаты — в статистике). */
$('btn-new').addEventListener('click', async function () {
  if (!confirm('Создать новую комнату для нового теста?')) return;
  try {
    await syncClock();
    let nr = null, st = null;
    do { nr = randomRoom(); st = await apiGet('rooms/' + nr + '.json', auth); }
    while (st);
    room = nr;
    state = { status: 'lobby', round: 0, topic: 'Тестирование студентов', created: new Date().toISOString() };
    await apiPut('rooms/' + room + '.json', state, auth);
    students = {};
    seenStudents.clear();
    answersByRound = {};
    seenAnswerFiles.clear();
    lastResults = null;
    judged = false;
    judging = false;
    lastJudgedKey = null;
    lastJudgedTitle = '';
    curRound = 0;
    localStorage.setItem('blitz_teach_room', room);
    enterLobby();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
});

/* На главную — к статистике (опрос комнаты останавливаем) */
$('btn-home').addEventListener('click', function () {
  clearInterval(pollInt);
  clearInterval(roundTimerInt);
  roundBoxOn = false;
  show('sec-stats');
  loadStats();
});
