'use strict';

/* =====================================================================
   Блиц-опрос — страница студента.
   Вход только с ФИО (минимум фамилию и имя) и ТОЛЬКО в комнату,
   которую преподаватель уже создал (иначе — сообщение об ошибке).
   Первая страница сайта (index.html) — вход только для студентов;
   преподаватель работает по прямой ссылке teacher.html.

   Очки за вопрос (считает преподаватель при проверке раунда):
   — верный ответ: 10 · M(n) + B, n — длина серии включая текущий ответ
     (n≤3 → ×1, 4–6 → ×2, ≥7 → ×3), B — бонус за скорость +4…+8;
   — неверный ответ: −7, серия обнуляется;
   — «Пропустить вопрос»: −3, серия сохраняется;
   — таймаут / нет ответа: −3, серия обнуляется.

   Личная панель (всегда видна): ФИО, очки, верно/неверно, общее
   время, текущее место, текущая серия и тройка лидеров.

   Бонусы (×2, ×3, «Время») заряжаются на экране ожидания ДО показа
   вопроса: каждый — один раз за тест, действует на следующий вопрос.
   ×2/×3 умножают очки раунда (в плюс и в минус), «Время» при верном
   ответе вычитает 80 с из общего времени. Заряд снимается повторным
   нажатием, пока вопрос не показан.

   Обратный отсчёт начинается, когда студент УВИДЕЛ вопрос. Текстовые
   ответы сохраняются в нижнем регистре; близкие по написанию ответы
   (расстояние Дамерау—Левенштейна, схожесть ≥ 0.80) преподавателю
   объединяются в одну группу. Полный рейтинг студентам не выводится —
   только тройка лучших; после завершения теста студент получает свой
   итоговый балл и место в общем рейтинге.
   ===================================================================== */

const $ = function (id) { return document.getElementById(id); };

let room = null;
let sid = null;
let name = '';
let state = null;
let bonuses = null;        // мой файл бонусов: {double, triple, time, used[]}

let lastShownRound = 0;    // раунд, который сейчас на экране
let submitted = false;     // ответ на показанный раунд отправлен
let lastAnswer = null;     // мой ответ текущего раунда (null — таймаут)
let wasSkip = false;       // текущий раунд пропущен кнопкой
let qStartPerf = 0;        // performance.now() в момент показа вопроса
let qDuration = 0;
let timerInt = null;
let pollInt = null;
let screen = 'join';
let finalShown = false;
let lastResults = null;
let judgeRoundShown = 0;
let lastKnownPoints = null;// очки до текущего раунда (для «+X за раунд»)
const RING_C = 326.73;     // длина окружности таймера (r=52)

/* ---------------- переключение экранов ---------------- */

function show(sec) {
  ['sec-join', 'sec-wait', 'sec-question', 'sec-sent', 'sec-late', 'sec-judge', 'sec-final']
    .forEach(function (s) { $(s).classList.add('hidden'); });
  $(sec).classList.remove('hidden');
  screen = sec.replace('sec-', '');
}

function setConn(ok) {
  $('conn').classList.toggle('on', ok);
  $('conn-text').textContent = ok ? 'связь с сервером есть' : 'нет связи с сервером';
}

function setRing(pct, low) {
  $('ring-fg').style.strokeDashoffset = (RING_C * (1 - pct)).toFixed(1);
  $('ring-wrap').classList.toggle('low', !!low);
}

/* ---------------- вход ---------------- */

(async function init() {
  const h = decodeURIComponent(location.hash || '').replace(/^#/, '');
  if (h) $('in-room').value = safeRoom(h);
  const r = localStorage.getItem('blitz_room');
  if (r && !h) $('in-room').value = r;
  const n = r && localStorage.getItem('blitz_name_' + r);
  if (n) $('in-name').value = n;
  /* индикатор связи ещё ДО входа: достаточно знать, что сервер доступен */
  fetch(apiUrl('rooms/'), { cache: 'no-store' })
    .then(function () { setConn(true); })
    .catch(function () { setConn(false); });
})();

$('btn-join').addEventListener('click', join);
$('in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
$('in-room').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });

async function join() {
  const errEl = $('name-error');
  errEl.textContent = '';
  room = safeRoom($('in-room').value);
  if (!room) {
    errEl.textContent = 'Введите код комнаты от преподавателя.';
    return;
  }
  const clean = validFullName($('in-name').value);
  if (!clean) {
    errEl.textContent = 'Без ФИО войти нельзя. Укажите минимум фамилию и имя, например «Иванов Иван».';
    $('in-name').classList.add('shake');
    setTimeout(function () { $('in-name').classList.remove('shake'); }, 500);
    return;
  }
  name = clean;
  $('btn-join').disabled = true;
  try {
    await syncClock();
    // войти можно ТОЛЬКО в комнату, созданную преподавателем
    const st = await apiGet('rooms/' + room + '.json');
    if (!st) {
      errEl.textContent = 'Комната «' + room + '» не найдена: преподаватель ещё не создал её. Проверьте код.';
      $('btn-join').disabled = false;
      return;
    }
    if (st.status === 'done') {
      errEl.textContent = 'Тест в этой комнате уже завершён. Попросите преподавателя создать новую комнату.';
      $('btn-join').disabled = false;
      return;
    }
    sid = localStorage.getItem('blitz_sid_' + room) || safeId(name);
    localStorage.setItem('blitz_sid_' + room, sid);
    localStorage.setItem('blitz_name_' + room, name);
    localStorage.setItem('blitz_room', room);
    // профиль студента создаём один раз: накопленные очки хранит
    // преподаватель, повторный вход (обновление страницы) их не сбрасывает
    const exist = await apiGet('students/' + room + '/' + sid + '.json');
    if (!exist) {
      await apiPut('students/' + room + '/' + sid + '.json', {
        sid: sid, name: name, at: new Date().toISOString()
      });
    }
    $('wait-text').textContent = 'Вы в комнате. Ждём начала…';
    $('panel-personal').classList.remove('hidden');
    renderPersonal();
    await loadBonusMine();
    show('sec-wait');
    clearInterval(pollInt);
    pollInt = setInterval(tick, POLL_MS);
    tick();
  } catch (e) {
    errEl.textContent = 'Не удалось подключиться: ' + e.message +
      '. Проверьте код комнаты и связь с сервером.';
  }
  $('btn-join').disabled = false;
}

/* ---------------- бонусы (×2, ×3, «Время») ----------------
   Файл bonuses/{room}/{sid}.json: {sid, name, double, triple, time, used[]},
   где double/triple/time — номер вопроса, на который заряжен бонус.
   Зарядить можно только до показа вопроса (в лобби и на экране проверки),
   каждый бонус — один раз за тест. ×2/×3 умножают очки раунда
   (в плюс и в минус), «Время» при верном ответе вычитает 80 с из общего
   времени. Повторное нажатие на заряженный бонус снимает заряд. */

const BONUS_KEYS = ['double', 'triple', 'time'];
const BONUS_LABELS = { double: '×2', triple: '×3', time: '«Время»' };

async function loadBonusMine() {
  try {
    const b = await apiGet('bonuses/' + room + '/' + sid + '.json');
    bonuses = (b && typeof b === 'object') ? b
      : { sid: sid, name: name, double: null, triple: null, time: null, used: [] };
  } catch (e) { /* оставляем локальное состояние */ }
  renderBonuses();
}

function armedLabels() {
  const out = [];
  if (bonuses) {
    BONUS_KEYS.forEach(function (k) {
      if (+bonuses[k]) out.push(BONUS_LABELS[k] + ' → вопрос ' + bonuses[k]);
    });
  }
  return out;
}

function renderBonuses() {
  const used = (bonuses && bonuses.used) || [];
  BONUS_KEYS.forEach(function (k) {
    const btn = $('b-' + k);
    if (!btn) return;
    const isUsed = used.indexOf(k) !== -1;
    const isArmed = bonuses && +bonuses[k];
    btn.disabled = isUsed;
    btn.classList.toggle('used', isUsed);
    btn.classList.toggle('armed', !!isArmed);
  });
  const armed = armedLabels();
  const chip = $('p-armed');
  if (chip) {
    chip.classList.toggle('hidden', !armed.length);
    chip.textContent = armed.length ? 'Заряжено: ' + armed.join(' · ') : '';
  }
  /* чип внутри экрана вопроса: какие бонусы действуют именно сейчас */
  const qb = $('q-bonus');
  if (qb) {
    const act = [];
    if (bonuses && state && state.round != null) {
      BONUS_KEYS.forEach(function (k) {
        if (+bonuses[k] === state.round) act.push(BONUS_LABELS[k]);
      });
    }
    qb.classList.toggle('hidden', !act.length);
    qb.textContent = act.length ? 'Активны бонусы: ' + act.join(' · ') : '';
  }
}

async function armBonus(k) {
  if (!room || !sid || !state) return;
  if (state.status === 'active' || state.status === 'done') return;  // только до показа вопроса
  if (!bonuses) bonuses = { sid: sid, name: name, double: null, triple: null, time: null, used: [] };
  if ((bonuses.used || []).indexOf(k) !== -1) return;                // израсходован
  const target = (state.round || 0) + 1;                             // следующий вопрос
  if (+bonuses[k] === target) {
    bonuses[k] = null;                                               // снять заряд
  } else {
    if (+bonuses[k]) return;                                         // заряжен на другой вопрос
    if (k === 'double' && +bonuses.triple === target) bonuses.triple = null; // ×2 и ×3 не суммируются
    if (k === 'triple' && +bonuses.double === target) bonuses.double = null;
    bonuses[k] = target;
  }
  renderBonuses();
  try { await apiPut('bonuses/' + room + '/' + sid + '.json', bonuses); }
  catch (e) { /* при следующей попытке отправим снова */ }
}

$('b-double').addEventListener('click', function () { armBonus('double'); });
$('b-triple').addEventListener('click', function () { armBonus('triple'); });
$('b-time').addEventListener('click', function () { armBonus('time'); });

/* ---------------- личная панель (всегда видна после входа) ---------------- */

function renderPersonal() {
  const rows = lastResults ? rankFromScores(lastResults.scores) : [];
  const me = rows.find(function (r) { return r.sid === sid; }) || null;
  const own = (lastResults && lastResults.scores && lastResults.scores[sid]) || null;

  $('p-name').textContent = name;
  $('p-points').textContent = own ? own.points : '—';
  $('p-correct').textContent = own ? own.correct : '—';
  $('p-wrong').textContent = own ? own.wrong : '—';
  $('p-time').textContent = own ? fmtTime(own.time) : '—';
  $('p-place').textContent = me ? (me.place + ' / ' + rows.length) : '—';
  $('p-streak').textContent = own ? (own.streak || 0) : '—';
  if (own && lastKnownPoints == null) lastKnownPoints = own.points;

  // тройка лидеров
  const pod = $('p-podium');
  pod.textContent = '';
  const cls = ['p1', 'p2', 'p3'];
  const top = rows.slice(0, 3);
  if (!top.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'Рейтинг появится после первого проверенного раунда.';
    pod.appendChild(d);
    return;
  }
  top.forEach(function (r, i) {
    const d = document.createElement('div');
    d.className = 'pod ' + cls[i];
    const b = document.createElement('b');
    b.textContent = i + 1;
    const s = document.createElement('span');
    s.textContent = r.name;
    s.title = r.name;
    d.append(b, s);
    pod.appendChild(d);
  });
}

/* ---------------- фоновый опрос ---------------- */

async function tick() {
  try {
    syncClock();
    const st = await apiGet('rooms/' + room + '.json');
    setConn(true);
    state = st;
    if (!st) {
      // комнаты больше нет: преподаватель удалил её после завершения теста
      if (screen === 'final' || finalShown) return;      // итоги уже показаны
      const cached = readFinalCache();
      if (cached) { showFinalFromCache(cached); return; }
      if (screen !== 'wait') show('sec-wait');
      $('wait-text').textContent = localStorage.getItem('blitz_sid_' + room)
        ? 'Комната закрыта: преподаватель завершил тест. Итоги — у преподавателя.'
        : 'Комната не найдена. Преподаватель ещё не создал её — проверьте код.';
      return;
    }
    try { lastResults = await apiGet('results/' + room + '.json'); }
    catch (e) { /* оставляем предыдущие данные */ }
    renderPersonal();
    if (st.status === 'active' && st.round) {
      if (lastShownRound !== st.round) { await showQuestion(st); return; }
      if (screen === 'question') updateTimer();
      // если ответ уже отправлен — остаёмся на экране «Ответ принят»
    } else if (st.status === 'judge') {
      showJudge(st);
    } else if (st.status === 'done') {
      showFinal();
    } else { // lobby — ждём следующего вопроса
      if (finalShown) return; // тест завершён — остаёмся на итогах
      if (screen !== 'wait') show('sec-wait');
      $('wait-text').textContent = 'Ждём следующего вопроса…';
    }
  } catch (e) {
    setConn(false);
  }
}

/* ---------------- показ вопроса ---------------- */

async function showQuestion(st) {
  if (lastShownRound === st.round) return;
  lastShownRound = st.round;

  // база для подсчёта «+X очков за раунд» на экране проверки
  const own = (lastResults && lastResults.scores && lastResults.scores[sid]) || null;
  lastKnownPoints = own ? own.points : (lastKnownPoints == null ? 0 : lastKnownPoints);

  // после перезагрузки страницы: возможно, ответ уже отправлен
  try {
    const prev = await apiGet('answers/' + room + '/r' + st.round + '_' + sid + '.json');
    if (prev) {
      lastAnswer = prev.answer;
      wasSkip = !!prev.skip;
      submitted = true;
      $('sent-text').textContent = wasSkip
        ? 'Вопрос пропущен (−3, серия сохранена). Ждём остальных…'
        : 'Ответ принят: ' + prev.answer + '. Ждём остальных…';
      show('sec-sent');
      return;
    }
  } catch (e) { /* ответа ещё нет — отвечаем */ }

  const remainMs = st.startedAt + st.duration * 1000 - serverNow();
  if (remainMs <= 500) {
    // зашёл, когда время уже истекло
    submitted = true;
    lastAnswer = null;
    wasSkip = false;
    $('late-text').textContent = 'Раунд ' + st.round + ': время истекло, ответ не принят.';
    show('sec-late');
    return;
  }

  submitted = false;
  lastAnswer = null;
  wasSkip = false;
  qDuration = st.duration;
  qStartPerf = performance.now();

  $('q-round').textContent = 'Раунд ' + st.round;
  $('q-type').textContent = st.type === 'choice' ? 'Выберите один из вариантов' : 'Введите ответ текстом';
  renderBonuses();

  const grid = $('q-options');
  grid.textContent = '';
  if (st.type === 'choice') {
    $('q-choice').classList.remove('hidden');
    $('q-textblock').classList.add('hidden');
    CHOICE_OPTIONS.forEach(function (o, i) {
      const b = document.createElement('button');
      b.textContent = optionLabel(i);       // «1.А», «2.Б», «3.В», «4.Г», «5.Д»
      b.addEventListener('click', function () { submit(optionLabel(i), false); });
      grid.appendChild(b);
    });
  } else {
    $('q-choice').classList.add('hidden');
    $('q-textblock').classList.remove('hidden');
    $('q-input').value = '';
    show('sec-question');
    $('q-input').focus();
  }

  show('sec-question');
  updateTimer();
  clearInterval(timerInt);
  timerInt = setInterval(updateTimer, 100);
}

function updateTimer() {
  if (!state) return;
  const rem = (state.startedAt + qDuration * 1000 - serverNow()) / 1000;
  const shown = Math.max(0, rem);
  $('t-num').textContent = Math.ceil(shown);
  setRing(Math.max(0, Math.min(1, shown / qDuration)), shown < qDuration * 0.25);
  if (rem <= -GRACE_SECONDS) {
    // время вышло, ответ так и не отправлен
    clearInterval(timerInt);
    if (!submitted) {
      submitted = true;
      lastAnswer = null;
      wasSkip = false;
      $('late-text').textContent = 'Время вышло. Ответ не отправлен: −3 очка, серия сброшена.';
      show('sec-late');
    }
  }
}

/* ---------------- отправка ответа и пропуск ---------------- */

async function submit(answer, skip) {
  if (submitted || !state) return;
  submitted = true; // защита от двойного нажатия
  clearInterval(timerInt);
  // затраченное время — от момента, когда студент увидел вопрос
  const elapsed = Math.max(0.1,
    Math.min((performance.now() - qStartPerf) / 1000, qDuration + GRACE_SECONDS));
  lastAnswer = skip ? '(пропуск)' : answer;
  wasSkip = !!skip;
  try {
    await apiPut('answers/' + room + '/r' + state.round + '_' + sid + '.json', {
      sid: sid,
      name: name,
      answer: lastAnswer,
      elapsed: Math.round(elapsed * 10) / 10,
      skip: !!skip,
      at: new Date().toISOString()
    });
    $('sent-text').textContent = skip
      ? 'Вопрос пропущен (−3, серия сохранится). Ждём остальных…'
      : 'Ответ принят: ' +
        (state.type === 'choice' ? ('вариант ' + answer) : ('«' + answer + '»')) +
        '. Ждём остальных…';
    show('sec-sent');
  } catch (e) {
    submitted = false;
    alert('Не удалось отправить ответ: ' + e.message);
  }
}

$('q-send').addEventListener('click', function () {
  const v = $('q-input').value.trim().slice(0, 200);
  if (!v) { alert('Введите ответ'); return; }
  // текстовые ответы — в нижнем регистре
  submit(v.toLowerCase(), false);
});
$('q-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') $('q-send').click();
});
$('q-skip').addEventListener('click', function () {
  if (submitted) return;
  if (!confirm('Пропустить вопрос? Будет начислено −3 очка, текущая серия сохранится.')) return;
  submit(null, true);
});

/* ---------------- проверка раунда ---------------- */

function showJudge(st) {
  if (st.round === judgeRoundShown && screen === 'judge') return;
  judgeRoundShown = st.round;
  clearInterval(timerInt);
  loadBonusMine();   // преподаватель израсходовал заряженные бонусы — обновляем
  const corr = st.lastCorrect;
  const own = (lastResults && lastResults.scores && lastResults.scores[sid]) || null;
  const nowPts = own ? own.points : null;
  const delta = (nowPts != null && lastKnownPoints != null) ? nowPts - lastKnownPoints : null;
  if (nowPts != null) lastKnownPoints = nowPts;

  let msg;
  if (wasSkip) {
    msg = 'Вы пропустили вопрос: −3 очка, серия сохранена.';
  } else if (corr == null) {
    msg = 'Раунд закрыт без правильного ответа.\nВаш ответ: ' +
      (lastAnswer == null ? '— (не ответили: −3, серия сброшена)' : lastAnswer + ' — неверно (−7, серия сброшена)');
  } else {
    const mine = lastAnswer;
    const ok = mine != null && !wasSkip && (st.type === 'choice'
      ? String(mine) === String(corr)
      : isSimilarText(normText(mine), normText(corr)));
    if (mine == null) {
      msg = 'Правильный ответ: ' + corr +
        '\nВы не ответили: −3 очка, серия сброшена.';
    } else {
      msg = 'Правильный ответ: ' + corr +
        '\nВаш ответ: ' + mine + (ok ? ' — верно' : ' — неверно (−7, серия сброшена)');
    }
  }
  if (delta != null && delta !== 0) {
    msg += '\nОчки за раунд: ' + (delta > 0 ? '+' + delta : delta) +
      (nowPts != null ? ' · всего: ' + nowPts : '');
  }
  $('verdict').textContent = msg;
  show('sec-judge');
}

/* ---------------- итоги ----------------
   Студенту отправляется его итоговая оценка (балл) и место в общем
   рейтинге; полный рейтинг не выводится — только тройка лучших.
   Итог кэшируется локально: после удаления комнаты преподавателем
   экран итогов всё равно доступен. */

function readFinalCache() {
  try {
    const raw = localStorage.getItem('blitz_final_' + room);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function showFinal() {
  if (finalShown) return;
  const st = state;
  let rows = null;
  if (st && Array.isArray(st.standings) && st.standings.length) {
    rows = st.standings;                       // преподаватель прислал итоги
  } else if (lastResults && lastResults.finished) {
    rows = rankFromScores(lastResults.scores); // считаем сами из результатов
  }
  if (!rows) {
    if (screen !== 'wait') show('sec-wait');
    $('wait-text').textContent = 'Ждём итогов…';
    return;
  }
  finalShown = true;
  renderFinalScreen(rows);
}

function showFinalFromCache(cached) {
  if (finalShown) return;
  finalShown = true;
  $('final-me').textContent = '';
  const big = document.createElement('div');
  big.className = 'final-score';
  big.textContent = 'Ваш балл: ' + cached.score + ' · место ' + cached.place + ' из ' + cached.total;
  $('final-me').appendChild(big);
  const grp = document.createElement('div');
  grp.className = 'final-group';
  grp.textContent = 'Группа: ' + (cached.groupName || '—');
  $('final-me').appendChild(grp);
  show('sec-final');
}

function renderFinalScreen(rows) {
  const me = rows.find(function (r) { return r.sid === sid; }) || null;
  const fm = $('final-me');
  fm.textContent = '';
  if (me) {
    const big = document.createElement('div');
    big.className = 'final-score';
    big.textContent = 'Ваш балл: ' + me.score + ' · место ' + me.place + ' из ' + rows.length;
    fm.appendChild(big);
    const grp = document.createElement('div');
    grp.className = 'final-group';
    grp.textContent = 'Группа: ' + GROUP_NAMES[me.group || 0];
    fm.appendChild(grp);
    // кэш на случай удаления комнаты преподавателем
    try {
      localStorage.setItem('blitz_final_' + room, JSON.stringify({
        score: me.score, place: me.place, total: rows.length,
        groupName: GROUP_NAMES[me.group || 0]
      }));
    } catch (e) { /* не критично */ }
  } else {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'Тест завершён. Ваших результатов в итоговой таблице нет.';
    fm.appendChild(d);
  }

  const box = $('final-top3');
  box.textContent = '';
  const cls = ['p1', 'p2', 'p3'];
  const top = rows.slice(0, 3);
  if (!top.length) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'Пока нет результатов.';
    box.appendChild(d);
  }
  top.forEach(function (r, i) {
    const d = document.createElement('div');
    d.className = 'pod ' + cls[i];
    const b = document.createElement('b');
    b.textContent = i + 1;
    const s = document.createElement('span');
    s.textContent = r.name;
    s.title = r.name;
    const sc = document.createElement('i');
    sc.className = 'score';
    sc.textContent = r.score;
    d.append(b, s, sc);
    box.appendChild(d);
  });

  show('sec-final');
}
