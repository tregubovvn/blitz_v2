'use strict';

/* =====================================================================
   Блиц-опрос — общий модуль (страницы преподавателя и студента)
   Обмен данными: JSON-файлы на сервере 194.87.103.77 через nginx
   (GET — чтение, PUT — запись; каталоги создаёт сам nginx).
   ===================================================================== */

/* ====== Адрес обмена данными: определяется АВТОМАТИЧЕСКИ ======
   — Страница открыта с сервера nginx (http://194.87.103.77/blitz/…):
     API доступен по тому же пути (/blitz/data) — CORS вообще не нужен.
   — Страница открыта на GitHub Pages (*.github.io) или локально при
     отладке (localhost, 127.0.0.1): запросы идут на
     http://194.87.103.77/blitz/data — нужен CORS, он уже настроен
     в nginx/blitz.conf (Access-Control-Allow-Origin *).
   ВАЖНО для отладки на GitHub Pages: открывайте страницу по http://
   (НЕ включайте "Enforce HTTPS"), иначе браузер заблокирует запросы
   к http-API как mixed content. Если API будет по HTTPS — замените
   строку ниже на https-адрес.
   Если отлаживаете с другого хоста по LAN-IP — задайте адрес явно. */
const API_BASE = /(\.github\.io|localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://194.87.103.77/blitz/data'  // отладка: GitHub Pages / локально
  : '/blitz/data';                     // продакшн: тот же сервер nginx

/* Параметры теста */
const CHOICE_OPTIONS   = ['А', 'Б', 'В', 'Г', 'Д'];
const CHOICE_SECONDS   = 20;   // раунд «выбор варианта»
const TEXT_SECONDS     = 40;   // раунд «ввод текста»
const GRACE_SECONDS    = 3;    // запас на задержки сети при отправке
const MISS_PENALTY_SEC = 5;    // штраф ко времени за пропущенный раунд
const POLL_MS          = 1500; // период опроса сервера

/* ---------------- очки за вопрос (актуальные правила) ----------------
   Верный ответ:      S = 10 · M(n) + B,  n — длина серии ВКЛЮЧАЯ текущий
                      верный ответ; M: n≤3 → 1, 4≤n≤6 → 2, n≥7 → 3;
                      B — бонус за скорость, от +4 до +8 по доле
                      оставшегося времени.
   Неверный ответ:    S = −7, серия сбрасывается (n = 0).
   Пропуск (кнопка):  S = −3, серия СОХРАНЯЕТСЯ.
   Таймаут / нет ответа: S = −3, серия сбрасывается. */
const S_CORRECT = 10;   // база верного ответа
const S_WRONG   = -7;   // неверный ответ
const S_SKIP    = -3;   // намеренный пропуск
const S_TIMEOUT = -3;   // не ответил вовремя
const BONUS_MIN = 4;    // бонус за скорость при ответе в последний момент
const BONUS_MAX = 8;    // бонус за скорость при мгновенном ответе
const TIME_BONUS_SEC = 80; // бонус «Время»: −80 с от общего времени при верном ответе

/* Множитель серии по её длине n (включая текущий верный ответ) */
function streakMult(n) { n = +n || 0; return n >= 7 ? 3 : (n >= 4 ? 2 : 1); }

/* Бонус за скорость: elapsed — затраченное время, dur — длительность раунда.
   Ответил мгновенно → +8, в последний момент → +4 (шаг 1 очко). */
function speedBonus(elapsed, dur) {
  const f = dur > 0 ? Math.max(0, Math.min(1, (dur - (+elapsed || 0)) / dur)) : 0;
  return Math.round(BONUS_MIN + (BONUS_MAX - BONUS_MIN) * f);
}
/* Подписи вариантов: «1.А», «2.Б», «3.В», «4.Г», «5.Д» */
function optionLabel(i) { return (i + 1) + '.' + CHOICE_OPTIONS[i]; }

const GROUP_NAMES = ['Отлично · Золото', 'Хорошо · Серебро', 'Удовлетворительно · Бронза'];

/* ---------------- низкоуровневый обмен с nginx ---------------- */

function apiUrl(path) { return API_BASE + '/' + path; }

async function apiGet(path, auth) {
  const headers = {};
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(apiUrl(path), { method: 'GET', cache: 'no-store', headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GET ' + r.status);
  return r.json();
}

async function apiPut(path, obj, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: headers,
    body: JSON.stringify(obj)
  });
  if (!r.ok) throw new Error('PUT ' + r.status);
  return true;
}

/* Удаление файла (nginx WebDAV DELETE). Отсутствие файла — не ошибка. */
async function apiDelete(path, auth) {
  const headers = {};
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(apiUrl(path), { method: 'DELETE', headers: headers });
  if (r.status === 404) return true;
  if (!r.ok) throw new Error('DELETE ' + r.status);
  return true;
}

/* Список .json-файлов каталога через autoindex nginx (HTML-листинг) */
async function apiList(dir) {
  const r = await fetch(apiUrl(dir) + '/', { cache: 'no-store' });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('LIST ' + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const out = [];
  doc.querySelectorAll('a[href]').forEach(function (a) {
    const h = decodeURIComponent(a.getAttribute('href'));
    if (h.endsWith('/')) return;               // подкаталоги не нужны
    const name = h.split('/').pop();
    if (name.toLowerCase().endsWith('.json')) out.push(name);
  });
  return out;
}

/* ---------------- серверное время (по заголовку Date) ----------------
   Точная синхронизация часов не требуется: смещение определяется по
   заголовку Date ответа nginx и используется только чтобы студенты,
   зашедшие в середине раунда, видели оставшееся время. */

let _clockOffset = 0;
async function syncClock() {
  try {
    const r = await fetch(apiUrl('../probe' + Math.random().toString(36).slice(2)), { cache: 'no-store' });
    const d = r.headers.get('Date');
    if (d) _clockOffset = new Date(d).getTime() - Date.now();
  } catch (e) { /* нет связи — используем локальные часы */ }
}
function serverNow() { return Date.now() + _clockOffset; }

/* ---------------- вспомогательное ---------------- */

function normText(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я\s-]/gi, ' ')   // знаки препинания — в пробел
    .replace(/\s+/g, ' ').trim();
}

/* ---------------- текстовые ответы: опечатки ----------------
   Расстояние Дамерау—Левенштейна (с транспозицией соседних символов),
   нормированное по длине более длинного слова. Порог 0.80 — это порог
   СХОЖЕСТИ: слова объединяются, если 1 − dist/maxLen ≥ 0.80,
   т.е. нормированное расстояние не больше 0.20. */
const TEXT_SIM = 0.80;

function dlDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prevPrev = null;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);   // транспозиция
      }
      cur[j] = v;
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[n];
}

/* Схожесть 0…1: 1 — строки одинаковы */
function textSim(a, b) {
  const L = Math.max(String(a).length, String(b).length, 1);
  return 1 - dlDistance(a, b) / L;
}

function isSimilarText(a, b) {
  return textSim(a, b) >= TEXT_SIM;
}

/* Группировка текстовых ответов: приходит список {answer, name},
   возвращаются кластеры близких ответов {key, title, names, count}.
   Эталоном кластера становится первый пришедший ответ. */
function textCluster(items) {
  const groups = [];
  (items || []).forEach(function (it) {
    const n = normText(it.answer);
    if (!n) return;
    let g = null;
    for (let i = 0; i < groups.length; i++) {
      if (isSimilarText(groups[i].key, n)) { g = groups[i]; break; }
    }
    if (g) { g.names.push(it.name); g.count++; }
    else groups.push({ key: n, title: String(it.answer).trim(), names: [it.name], count: 1 });
  });
  return groups;
}

const _TR = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya' };

/* латинский id из имени (для имён файлов) + случайный суффикс */
function safeId(name) {
  const base = String(name || '').toLowerCase().split('')
    .map(function (ch) { return Object.prototype.hasOwnProperty.call(_TR, ch) ? _TR[ch] : ch; })
    .filter(function (ch) { return /[a-z0-9]/.test(ch); })
    .join('').slice(0, 14);
  return (base || 'student') + '-' + Math.random().toString(36).slice(2, 6);
}

function safeRoom(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function randomRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function fmtTime(sec) {
  sec = Math.round(+sec || 0);
  if (sec < 60) return sec + ' с';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ' мин ' + (s ? s + ' с' : '');
}

/* Деление на 3 группы по долям в процентах (по умолчанию 50 / 30 / 20;
   настройки комнаты задают доли с точностью до 10 %), метод наибольших
   остатков, чтобы при маленьком числе участников квоты распределялись
   корректно. Возвращает [кол-во «отлично», «хорошо», «удовлетворительно»]. */
function splitGroups(n, shares) {
  const sh = (Array.isArray(shares) && shares.length === 3) ? shares : [50, 30, 20];
  const quota = [n * sh[0] / 100, n * sh[1] / 100, n * sh[2] / 100];
  const cnt = quota.map(Math.floor);
  let rest = n - cnt.reduce(function (a, b) { return a + b; }, 0);
  quota
    .map(function (v, i) { return { i: i, f: v - Math.floor(v) }; })
    .sort(function (a, b) { return b.f - a.f; })
    .forEach(function (o) { if (rest > 0) { cnt[o.i]++; rest--; } });
  return cnt;
}

/* Рейтинг из накопленных результатов: балл = 70% за набранные очки
   (относительно максимума) + 30% за скорость (меньше суммарное время —
   лучше), сортировка и деление на группы 50/30/20.
   Очки за вопрос: верный — 10 · M(серии) + бонус за скорость (+4…+8),
   неверный — −7 (серия обнуляется), пропуск — −3 (серия сохраняется),
   таймаут — −3 (серия обнуляется).
   Каждая строка получает place (место) и group (0=Золото, 1=Серебро, 2=Бронза). */
function rankFromScores(scores, shares) {
  const rows = Object.keys(scores || {}).map(function (sid) {
    const s = scores[sid] || {};
    return {
      sid: sid,
      name: s.name || sid,
      points: +s.points || 0,
      correct: +s.correct || 0,
      wrong: +s.wrong || 0,
      skip: +s.skip || 0,
      streak: +s.streak || 0,
      time: +s.time || 0
    };
  });
  if (!rows.length) return [];
  const maxPoints = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.points; })));
  /* минимум берём только по положительным временам: бонус «Время» может обнулить
     время отдельного студента — остальные не должны из-за этого терять балл
     за скорость (нулевое время трактуется как лучшее) */
  const posTimes = rows.map(function (r) { return +r.time || 0; }).filter(function (t) { return t > 0; });
  const minTime = posTimes.length ? Math.min.apply(null, posTimes) : 0;
  rows.forEach(function (r) {
    const tN = !(+r.time > 0) || minTime <= 0 ? 1 : minTime / r.time;
    r.score = Math.round((70 * (r.points / maxPoints) + 30 * tN) * 10) / 10;
  });
  rows.sort(function (a, b) {
    return b.score - a.score || b.points - a.points || a.time - b.time ||
      a.name.localeCompare(b.name);
  });
  const g = splitGroups(rows.length, shares);
  rows.forEach(function (r, i) {
    r.place = i + 1;
    r.group = i < g[0] ? 0 : (i < g[0] + g[1] ? 1 : 2);
  });
  return rows;
}

/* Сортировка строк по НАБРАННЫМ ОЧКАМ (не по итоговому баллу):
   очки ↓, при равенстве — меньше времени, затем по ФИО. */
function rankByPoints(rows) {
  return (rows || []).slice().sort(function (a, b) {
    return (+b.points || 0) - (+a.points || 0) ||
      (+a.time || 0) - (+b.time || 0) ||
      String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/* Тройка лидеров по очкам из карты scores{sid: {name, points, time, score}} */
function topByPoints(scores, n) {
  const rows = Object.keys(scores || {}).map(function (sid) {
    const s = scores[sid] || {};
    return {
      sid: sid, name: s.name || sid, points: +s.points || 0,
      time: +s.time || 0, score: s.score
    };
  });
  return rankByPoints(rows).slice(0, n || 3);
}

/* Рейтинг команд (режим команд): баллы команды = сумма баллов участников.
   Сортировка по очкам; группы (Золото/Серебро/Бронза) распределяются по
   тем же долям, что и у студентов, но применённым к числу КОМАНД. */
function rankTeams(scores, teams, shares) {
  const rows = (teams || []).map(function (t) {
    const sids = t.sids || [];
    const pts = sids.reduce(function (a, sid) {
      const s = (scores || {})[sid];
      return a + (s ? (+s.points || 0) : 0);
    }, 0);
    return { name: t.name, sids: sids, members: sids.length, points: pts };
  });
  if (!rows.length) return [];
  rows.sort(function (a, b) {
    return b.points - a.points || a.name.localeCompare(b.name);
  });
  const g = splitGroups(rows.length, shares);
  rows.forEach(function (r, i) {
    r.place = i + 1;
    r.group = i < g[0] ? 0 : (i < g[0] + g[1] ? 1 : 2);
  });
  return rows;
}

/* Проверка ФИО: минимум два слова (фамилия и имя), только буквы,
   дефис и пробел. Возвращает нормализованное имя или null. */
function validFullName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length < 5) return null;
  if (!/^[А-ЯЁа-яёA-Za-z\- ]+$/.test(s)) return null;
  const parts = s.split(' ').filter(function (p) { return p.length >= 2; });
  if (parts.length < 2) return null;
  return parts.map(function (p) {
    return p.split('-').map(function (w) {
      return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
    }).join('-');
  }).join(' ');
}
