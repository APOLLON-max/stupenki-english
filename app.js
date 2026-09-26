(function () {
  'use strict';

  // ---------- утилиты ----------
  const $ = (s, el = document) => el.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c)); });
    return el;
  }
  const rand = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const DAY = 864e5;
  const MAXL = LEVELS.length - 1;
  const SKILL_IDS = Object.keys(SKILLS);
  const WMAP = Object.fromEntries(WORDS.map(w => [w.en, w]));
  const todayStr = (d = new Date()) => d.toLocaleDateString('sv-SE');

  // ---------- хранение ----------
  const KEY = 'stupenki-v1';
  const fresh = () => ({ v: 1, tested: false, levels: { vocab: 0, grammar: 0, reading: 0 }, mastery: {}, cards: {}, xp: 0, streak: { n: 0, last: null }, sessions: 0, sound: true });
  // Данные из localStorage и облака не доверенные: приводим к ожидаемой форме,
  // чтобы кривой или чужой JSON не ломал экраны (например, уровень 99 → LEVELS[99]).
  function normalize(s) {
    if (!s || typeof s !== 'object' || s.v !== 1) return null;
    const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    const num = x => (Number.isFinite(+x) ? +x : 0);
    const out = Object.assign(fresh(), s);
    const lv = obj(s.levels);
    out.levels = {};
    for (const k of SKILL_IDS) out.levels[k] = Math.min(MAXL, Math.max(0, Math.round(num(lv[k]))));
    out.mastery = obj(s.mastery);
    out.cards = obj(s.cards);
    const st = obj(s.streak);
    out.streak = { n: num(st.n), last: typeof st.last === 'string' ? st.last : null };
    out.xp = num(s.xp); out.sessions = num(s.sessions); out.savedAt = num(s.savedAt);
    out.sound = s.sound !== false;
    return out;
  }
  function load() { try { return normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) {} return null; }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function save() { S.savedAt = Date.now(); saveLocal(); cloudSave(); }
  let S = load() || fresh();

  // ---------- облако (Supabase) ----------
  // Настройки в config.js; пустой url — работаем только с localStorage.
  // PIN отправляется только при входе (stupenki_login) и нигде не хранится;
  // дальше устройство работает по случайному токену сессии. См. supabase/schema.sql.
  // Чтобы сменить базу, достаточно переписать rpc() и функции cloud*.
  const CFG = window.STUPENKI_CLOUD || {};
  const CLOUD = CFG.url && CFG.key && /^https:\/\//.test(CFG.url) ? CFG : null;
  const PROFILE_KEY = 'stupenki-profile';
  let profile = null; // { name, token }
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (p && typeof p.name === 'string') profile = p;
  } catch (e) {}
  let saveTimer = null, savePending = false, syncState = 'idle';

  async function rpc(fn, body, keepalive) {
    const payload = JSON.stringify(body);
    const r = await fetch(CLOUD.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      // keepalive даёт запросу пережить закрытие вкладки, но браузеры ограничивают его 64 КБ
      keepalive: !!keepalive && payload.length < 60000,
      headers: { 'Content-Type': 'application/json', apikey: CLOUD.key },
      body: payload,
    });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  function setSync(st) {
    syncState = st;
    const el = document.getElementById('sync-chip');
    if (el) { el.dataset.state = st; el.title = SYNC_TITLES[st]; }
  }
  function storeProfile() {
    try { profile ? localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)) : localStorage.removeItem(PROFILE_KEY); } catch (e) {}
  }
  // Сессия устройства больше не действует (выход на всех устройствах, смена PIN):
  // прогресс на устройстве оставляем, просим войти заново.
  function sessionLost() {
    clearTimeout(saveTimer); savePending = false;
    profile = null; storeProfile();
    loginScreen('Сессия на этом устройстве завершена — войдите снова.');
  }
  function cloudSave(now) {
    if (!CLOUD || !profile || !profile.token) return;
    clearTimeout(saveTimer);
    savePending = true;
    const run = () => {
      savePending = false;
      if (!profile || !profile.token) return;
      setSync('saving');
      return rpc('stupenki_save', { p_token: profile.token, p_data: S }, now)
        .then(res => {
          if (res && res.status === 'no_session') return sessionLost();
          setSync(res && res.status === 'ok' ? 'saved' : 'error');
        })
        .catch(() => setSync('offline'));
    };
    if (now) return run();
    saveTimer = setTimeout(run, 1500);
  }
  // Сверка с облаком: берём более свежую версию, свою — отправляем, если она новее.
  async function cloudPull() {
    if (!CLOUD || !profile || !profile.token) return;
    try {
      const res = await rpc('stupenki_load', { p_token: profile.token });
      if (res.status === 'no_session') return sessionLost();
      const remote = normalize(res.data);
      if (remote && remote.savedAt > (S.savedAt || 0)) {
        S = remote; saveLocal();
        if (!document.querySelector('.session')) home();
        setSync('saved');
      } else if (!remote || remote.savedAt < (S.savedAt || 0)) {
        cloudSave(true);
      } else setSync('saved');
    } catch (e) { setSync('offline'); }
  }
  async function logout() {
    const p = profile;
    clearTimeout(saveTimer); savePending = false;
    if (p && p.token) {
      try { await rpc('stupenki_save', { p_token: p.token, p_data: S }); } catch (e) {}
      rpc('stupenki_logout', { p_token: p.token }).catch(() => {});
    }
    profile = null; S = fresh();
    storeProfile(); saveLocal();
    loginScreen();
  }
  // Вход версии 1 хранил на устройстве PIN. Один раз меняем его на токен и забываем PIN.
  async function migrateLegacyProfile() {
    const pin = profile.pin;
    delete profile.pin; storeProfile();
    try {
      const res = await rpc('stupenki_login', { p_name: profile.name, p_pin: pin });
      if (res.token) {
        profile.token = res.token; storeProfile();
        const remote = normalize(res.data);
        if (remote && remote.savedAt > (S.savedAt || 0)) { S = remote; saveLocal(); }
        home(); cloudPull();
        return;
      }
    } catch (e) {}
    profile = null; storeProfile();
    loginScreen('Обновили защиту входа — введите имя и PIN ещё раз.');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && savePending) cloudSave(true);
    if (document.visibilityState === 'visible' && !document.querySelector('.session')) cloudPull();
  });

  // ---------- звук ----------
  // Основной путь: заранее записанные mp3 (audio/*.json) через один общий <audio>.
  // Не Web Audio: на iPhone Web Audio молчит при включённом беззвучном режиме,
  // а <audio> играет. Запуск синхронный — iOS разрешает звук только прямо в обработчике нажатия.
  // Запасной путь: голос браузера (Web Speech API), если записи ещё не загрузились.
  const TTS = 'speechSynthesis' in window;
  const bank = {};
  let actx;
  ['words', 'sentences'].forEach(f => fetch('audio/' + f + '.json').then(r => (r.ok ? r.json() : {})).then(j => Object.assign(bank, j)).catch(() => {}));
  const canSpeak = () => TTS || Object.keys(bank).length > 0;
  const player = new Audio();
  player.preload = 'auto';
  player.setAttribute('playsinline', '');
  const SILENT = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAACAAAA/oAR0dHR0dHR0dHR0dHYmJiYmJiYmJiYmJifHx8fHx8fHx8fHx8fJaWlpaWlpaWlpaWlrGxsbGxsbGxsbGxsbHLy8vLy8vLy8vLy8vl5eXl5eXl5eXl5eXl////////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQC1AAAAAAAAAP6YbndKQAAAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuOTkuNVVVVVVVVVVVVUxBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy45OS41VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy45OS41VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';
  let unlocked = false;
  function audioCtx() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) {}
    return actx;
  }
  // Первое касание: «разблокируем» плеер беззвучным клипом, чтобы потом звук мог
  // запускаться и сам (автоозвучка в «Послушай и выбери»).
  function unlockAudio() {
    audioCtx();
    if (unlocked) return;
    unlocked = true;
    try {
      player.src = SILENT;
      const p = player.play();
      // AbortError — беззвучный клип прервала настоящая озвучка, это нормально
      if (p && p.catch) p.catch(err => { if (err && err.name === 'NotAllowedError') unlocked = false; });
    } catch (e) { unlocked = false; }
  }
  ['touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
  function speak(text) {
    if (!S.sound || !text) return;
    const b64 = bank[text];
    if (b64) {
      try {
        if (TTS) speechSynthesis.cancel();
        player.pause();
        player.src = 'data:audio/mpeg;base64,' + b64;
        player.currentTime = 0;
        const p = player.play();
        if (p && p.catch) p.catch(() => ttsSpeak(text));
        return;
      } catch (e) {}
    }
    ttsSpeak(text);
  }
  function ttsSpeak(text) {
    if (!TTS) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.85;
      const v = speechSynthesis.getVoices().find(v => /^en[-_]US/i.test(v.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function beep(ok) {
    if (!S.sound) return;
    const c = audioCtx(); if (!c) return;
    try {
      const notes = ok ? [660, 880] : [300, 220];
      notes.forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = ok ? 'triangle' : 'sine'; o.frequency.value = f;
        const t = c.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.2);
      });
    } catch (e) {}
  }

  // ---------- модель ученика ----------
  const topicsOf = skill => Object.keys(TOPICS).filter(t => TOPICS[t].skill === skill);
  const activeTopics = () => Object.keys(TOPICS).filter(t => TOPICS[t].level <= S.levels[TOPICS[t].skill]);
  function mOf(t) {
    const x = S.mastery[t];
    if (x) return x.m;
    return TOPICS[t].level < S.levels[TOPICS[t].skill] ? 0.55 : 0.4;
  }
  function learn(topic, ok) {
    const t = S.mastery[topic] || { m: mOf(topic), n: 0 };
    t.m += 0.25 * ((ok ? 1 : 0) - t.m); t.n++;
    S.mastery[topic] = t;
  }
  // Лейтнер: 5 коробок, интервалы в днях
  const INTERVALS = [0, 1, 2, 4, 7, 15];
  function review(key, ok) {
    if (!key) return;
    const c = S.cards[key] || { box: 0, due: 0, n: 0, bad: 0 };
    c.n++;
    if (ok) { c.box = Math.min(5, c.box + 1); c.due = Date.now() + INTERVALS[c.box] * DAY; }
    else { c.box = 1; c.bad++; c.due = Date.now() + 10 * 60 * 1000; }
    S.cards[key] = c;
  }
  const boxOf = k => (S.cards[k] ? S.cards[k].box : 0);

  function strongWeak() {
    const touched = Object.keys(S.mastery).filter(t => TOPICS[t]);
    const strong = touched.filter(t => S.mastery[t].m >= 0.7).sort((a, b) => mOf(b) - mOf(a));
    const weak = touched.filter(t => S.mastery[t].m < 0.5).sort((a, b) => mOf(a) - mOf(b));
    return { strong, weak };
  }
  function levelProgress(skill) {
    const L = S.levels[skill];
    const ts = topicsOf(skill).filter(t => TOPICS[t].level === L);
    const done = ts.filter(t => S.mastery[t] && S.mastery[t].n >= 2 && S.mastery[t].m >= 0.65).length;
    return { done, total: ts.length };
  }
  function checkLevelUps() {
    const ups = [];
    for (const s of SKILL_IDS) {
      if (S.levels[s] >= MAXL) continue;
      const p = levelProgress(s);
      if (p.total && p.done === p.total) { S.levels[s]++; ups.push(s); }
    }
    return ups;
  }

  // ---------- задания ----------
  const KINDS = {
    'pick-emoji': { name: 'Угадай картинку', icon: '🃏', skill: 'vocab', note: 'Слово → картинка', ask: 'Выберите картинку' },
    'meaning':    { name: 'Что значит?', icon: '🧠', skill: 'vocab', note: 'Слово → перевод', ask: 'Что это значит?' },
    'pick-word':  { name: 'Что это?', icon: '🔤', skill: 'vocab', note: 'Картинка → слово', ask: 'Как это по-английски?' },
    'find':       { name: 'Найди на картинке', icon: '🔍', skill: 'vocab', note: 'Ищем предмет среди многих', ask: 'Найдите на картинке' },
    'listen':     { name: 'Послушай и выбери', icon: '🎧', skill: 'vocab', note: 'На слух', ask: 'Послушайте и выберите' },
    'spell':      { name: 'Собери слово', icon: '🧩', skill: 'vocab', note: 'По буквам', ask: 'Соберите слово из букв' },
    'match':      { name: 'Найди пары', icon: '🎴', skill: 'vocab', note: 'Картинка + слово', ask: 'Соедините картинку и слово' },
    'fill':       { name: 'Вставь слово', icon: '✏️', skill: 'grammar', note: 'Пропуск в предложении', ask: 'Вставьте пропущенное слово' },
    'order':      { name: 'Собери фразу', icon: '🧱', skill: 'grammar', note: 'Порядок слов', ask: 'Соберите фразу по-английски' },
    'tf':         { name: 'Правда или нет', icon: '⚖️', skill: 'reading', note: 'Фраза и картинка', ask: 'Фраза совпадает с картинкой?' },
    'text':       { name: 'Прочитай и ответь', icon: '📰', skill: 'reading', note: 'Короткий текст', ask: 'Прочитайте и ответьте' },
  };
  const spellable = w => /^[a-z]+$/.test(w.en) && w.en.length <= 9;

  function itemsOf(topic) {
    const [p, name] = topic.split(':');
    if (p === 'v') return WORDS.filter(w => w.t === name).map(w => 'v:' + w.en);
    if (p === 'g') return GRAMMAR[name].map((_, i) => 'g:' + name + ':' + i);
    if (topic === 'r:scenes') return SCENES.map((_, i) => 'r:scene:' + i);
    if (topic.startsWith('r:texts')) {
      const lv = +topic.slice(7);
      const out = [];
      TEXTS.forEach((t, ti) => { if (t.level === lv) t.q.forEach((_, qi) => out.push('r:text:' + ti + ':' + qi)); });
      return out;
    }
    return [];
  }
  function compat(key, kind) {
    if (!kind) return true;
    const p = key.split(':');
    if (KINDS[kind].skill === 'vocab') {
      if (p[0] !== 'v') return false;
      if (kind === 'spell') return spellable(WMAP[p[1]]);
      if (kind === 'listen') return canSpeak();
      return true;
    }
    if (kind === 'fill') return p[0] === 'g' && !!GRAMMAR[p[1]][p[2]].o;
    if (kind === 'order') return p[0] === 'g' && !!GRAMMAR[p[1]][p[2]].w;
    if (kind === 'tf') return p[1] === 'scene';
    if (kind === 'text') return p[1] === 'text';
    return true;
  }

  function vocabKind(box, lvl) {
    const canListen = canSpeak() && S.sound;
    if (lvl >= 4) return box <= 1 ? 'meaning' : box === 2 ? rand(['pick-word', 'meaning']) : 'spell';
    if (box <= 0) return rand(canListen ? ['pick-emoji', 'pick-emoji', 'listen'] : ['pick-emoji']);
    if (box === 1) return rand(['pick-word', 'find', 'meaning']);
    if (box === 2) return rand(canListen ? ['find', 'listen', 'pick-word'] : ['find', 'pick-word']);
    return 'spell';
  }

  function distractors(word, n) {
    const same = shuffle(WORDS.filter(w => w.t === word.t && w !== word));
    const other = shuffle(WORDS.filter(w => w.t !== word.t));
    return same.concat(other).slice(0, n);
  }

  function taskFromKey(key, kind) {
    const p = key.split(':');
    if (p[0] === 'v') {
      const w = WMAP[p[1]];
      const lvl = TOPICS['v:' + w.t].level;
      kind = kind || vocabKind(boxOf(key), lvl);
      if (kind === 'spell' && !spellable(w)) kind = lvl >= 4 ? 'meaning' : 'pick-word';
      if (kind === 'listen' && !(canSpeak() && S.sound)) kind = 'pick-emoji';
      const t = { kind, skill: 'vocab', topic: 'v:' + w.t, keys: [key], word: w, answer: `${w.e}  ${w.en} — ${w.ru}`, say: w.en };
      if (kind === 'find') t.options = shuffle([w, ...distractors(w, boxOf(key) >= 2 ? 11 : 8)]);
      else if (kind !== 'spell') t.options = shuffle([w, ...distractors(w, 3)]);
      return t;
    }
    if (p[0] === 'g') {
      const it = GRAMMAR[p[1]][+p[2]];
      const base = { skill: 'grammar', topic: 'g:' + p[1], keys: [key], item: it };
      if (it.w) return { ...base, kind: 'order', answer: `${it.w}${it.end} — ${it.ru}`, say: it.w + it.end };
      const full = it.s.replace('___', it.o[0]);
      return { ...base, kind: 'fill', options: shuffle(it.o), right: it.o[0], answer: `${full} — ${it.ru}`, say: full };
    }
    if (p[1] === 'scene') {
      const sc = SCENES[+p[2]];
      return { kind: 'tf', skill: 'reading', topic: 'r:scenes', keys: [key], ...sc, answer: `${sc.truth ? 'Правда' : 'Неправда'}. ${sc.s} — ${sc.ru}` };
    }
    if (p[1] === 'text') {
      const tx = TEXTS[+p[2]], q = tx.q[+p[3]];
      return { kind: 'text', skill: 'reading', topic: 'r:texts' + tx.level, keys: [key], tx, q, options: shuffle(q.o), right: q.o[0], answer: q.o[0] };
    }
  }

  // генератор простых фраз для «Правда или нет» уровня A0
  function genPhrase() {
    const r = Math.random(), truth = Math.random() < 0.5;
    const base = { kind: 'tf', skill: 'reading', topic: 'r:phrases', keys: [], truth };
    if (r < 0.4) {
      const pool = PHRASE_WORDS;
      const w = rand(pool);
      const shown = truth ? w : rand(pool.filter(x => x.t === w.t && x !== w));
      const s = thisIs(w);
      return { ...base, scene: shown.e, s, answer: `${truth ? 'Правда' : 'Неправда'}. ${s} — Это ${w.ru}.` };
    }
    if (r < 0.65) {
      const pool = WORDS.filter(w => w.t === 'colors');
      const c = rand(pool), shown = truth ? c : rand(pool.filter(x => x !== c));
      const s = `It is ${c.en}.`;
      return { ...base, scene: shown.e, s, answer: `${truth ? 'Правда' : 'Неправда'}. ${s} — Это ${c.ru} цвет.` };
    }
    const [pl, e, ru] = rand(COUNTABLE);
    const n = 2 + Math.floor(Math.random() * 3);
    const m = truth ? n : rand([2, 3, 4].filter(x => x !== n));
    const s = `There are ${NUM[n]} ${pl}.`;
    return { ...base, scene: e.repeat(m), s, answer: `${truth ? 'Правда' : 'Неправда'}. ${s} — Здесь ${n} ${ru}.` };
  }

  function taskFromTopic(topic, used, kind) {
    if (topic === 'r:phrases' && (!kind || kind === 'tf')) return genPhrase();
    const now = Date.now();
    const items = itemsOf(topic).filter(k => !used.has(k) && compat(k, kind));
    if (!items.length) return null;
    // сначала новые и «слабые» карточки, не ждущие своего интервала
    const score = k => { const c = S.cards[k]; if (!c) return 1 + Math.random(); if (c.due <= now) return Math.random(); return 2 + c.box + Math.random(); };
    items.sort((a, b) => score(a) - score(b));
    return taskFromKey(items[0], kind);
  }

  function matchTask(used) {
    const vt = activeTopics().filter(t => TOPICS[t].skill === 'vocab').sort((a, b) => mOf(a) - mOf(b)).slice(0, 3);
    let keys = shuffle(vt.flatMap(itemsOf)).filter(k => !used.has(k));
    keys.sort((a, b) => boxOf(a) - boxOf(b));
    keys = keys.slice(0, 4);
    if (keys.length < 4) return null;
    const words = keys.map(k => WMAP[k.slice(2)]);
    return { kind: 'match', skill: 'vocab', topic: null, keys, words };
  }

  function interleave(tasks) {
    const out = shuffle(tasks);
    for (let i = 1; i < out.length; i++) {
      if (out[i].kind === out[i - 1].kind) {
        const j = out.findIndex((t, k) => k > i && t.kind !== out[i - 1].kind);
        if (j > 0) [out[i], out[j]] = [out[j], out[i]];
      }
    }
    return out;
  }

  // карточка может ссылаться на удалённый из data.js материал — такие пропускаем
  function validKey(k) {
    const p = k.split(':');
    if (p[0] === 'v') return !!WMAP[p.slice(1).join(':')];
    if (p[0] === 'g') return !!(GRAMMAR[p[1]] && GRAMMAR[p[1]][+p[2]]);
    if (p[1] === 'scene') return !!SCENES[+p[2]];
    if (p[1] === 'text') return !!(TEXTS[+p[2]] && TEXTS[+p[2]].q[+p[3]]);
    return false;
  }
  function dueKeys() {
    const now = Date.now();
    return Object.entries(S.cards).filter(([k, c]) => c.due <= now && validKey(k))
      .sort((a, b) => a[1].box - b[1].box || a[1].due - b[1].due).map(e => e[0]);
  }

  // Тренировка дня: ~20% повторение, ~60% слабые темы, ~20% новое
  function buildSession(size = 10) {
    const used = new Set(), tasks = [];
    const add = t => { if (t) { tasks.push(t); t.keys.forEach(k => used.add(k)); } };
    dueKeys().slice(0, 3).forEach(k => add(taskFromKey(k)));

    const byWeak = activeTopics().sort((a, b) => mOf(a) - mOf(b));
    const focus = [];
    for (const s of SKILL_IDS) { const t = byWeak.find(x => TOPICS[x].skill === s); if (t) focus.push(t); }
    focus.sort((a, b) => mOf(a) - mOf(b));
    const plan = [focus[0], focus[1], focus[0], focus[2], focus[1], focus[0]].filter(Boolean);
    for (let i = 0; tasks.length < size - 3 && i < 30; i++) add(taskFromTopic(plan[i % plan.length], used));

    const nextTopics = SKILL_IDS.map(s => topicsOf(s).filter(t => TOPICS[t].level === S.levels[s]).sort((a, b) => (S.mastery[a]?.n || 0) - (S.mastery[b]?.n || 0))[0]).filter(Boolean);
    for (let i = 0; tasks.length < size - 1 && i < 30; i++) add(taskFromTopic(rand(nextTopics), used));
    add(matchTask(used));
    for (let i = 0; tasks.length < size && i < 30; i++) add(taskFromTopic(rand(byWeak.slice(0, 5)), used));
    return interleave(tasks);
  }

  function topicsForKind(kind) {
    const skill = KINDS[kind].skill;
    const all = topicsOf(skill).filter(t => t === 'r:phrases' ? kind === 'tf' : itemsOf(t).some(k => compat(k, kind)));
    const act = all.filter(t => TOPICS[t].level <= S.levels[skill]);
    if (act.length) return act.sort((a, b) => mOf(a) - mOf(b));
    const minL = Math.min(...all.map(t => TOPICS[t].level));
    return all.filter(t => TOPICS[t].level === minL);
  }
  function buildGame(kind) {
    const used = new Set(), tasks = [];
    if (kind === 'match') {
      for (let i = 0; i < 3; i++) { const t = matchTask(used); if (t) { tasks.push(t); t.keys.forEach(k => used.add(k)); } }
      return tasks;
    }
    const topics = topicsForKind(kind);
    const weighted = topics.slice(0, 2).concat(topics);
    for (let i = 0; tasks.length < 8 && i < 60; i++) {
      const t = taskFromTopic(weighted[i % weighted.length], used, kind);
      if (t) { tasks.push(t); t.keys.forEach(k => used.add(k)); }
    }
    return tasks;
  }

  // ---------- отрисовка заданий ----------
  // ctx: { reveal: bool } ; done({ ok, results })
  function speakBtn(text, big) {
    return h('button', { class: 'speak' + (big ? ' big' : ''), type: 'button', 'aria-label': 'Прослушать', onclick: e => { e.stopPropagation(); speak(text); } }, '🔊');
  }

  function choiceGrid(options, renderOpt, isRight, ctx, onPick, cls = '') {
    const grid = h('div', { class: 'choices ' + cls });
    const btns = options.map(o => {
      const b = h('button', { class: 'choice', type: 'button' }, renderOpt(o));
      b.addEventListener('click', () => {
        if (grid.dataset.locked) return;
        grid.dataset.locked = '1';
        const ok = isRight(o);
        if (ctx.reveal) {
          b.classList.add(ok ? 'right' : 'wrong');
          if (!ok) btns.forEach((x, i) => { if (isRight(options[i])) x.classList.add('right'); });
        } else b.classList.add('chosen');
        btns.forEach(x => x.disabled = true);
        onPick(ok, o);
      });
      return b;
    });
    grid.append(...btns);
    return grid;
  }

  const R = {};
  R['pick-emoji'] = (t, ctx, done) => h('div', { class: 'task' },
    h('div', { class: 'prompt-word' }, h('span', { class: 'en' }, t.word.en), speakBtn(t.word.en)),
    choiceGrid(t.options, o => h('span', { class: 'emo' }, o.e), o => o === t.word, ctx, ok => done({ ok }), 'c4'));

  R['meaning'] = (t, ctx, done) => h('div', { class: 'task' },
    h('div', { class: 'prompt-word' }, h('span', { class: 'en' }, t.word.en), speakBtn(t.word.en)),
    choiceGrid(t.options, o => o.ru, o => o === t.word, ctx, ok => done({ ok }), 'words stack'));

  R['pick-word'] = (t, ctx, done) => h('div', { class: 'task' },
    h('div', { class: 'prompt-emoji' }, t.word.e),
    choiceGrid(t.options, o => o.en, o => o === t.word, ctx, ok => done({ ok }), 'words'));

  R['listen'] = (t, ctx, done) => {
    setTimeout(() => speak(t.word.en), 250);
    return h('div', { class: 'task' },
      h('div', { class: 'prompt-listen' }, speakBtn(t.word.en, true), h('p', { class: 'muted' }, 'Нажмите, чтобы послушать ещё раз')),
      choiceGrid(t.options, o => h('span', { class: 'emo' }, o.e), o => o === t.word, ctx, ok => done({ ok }), 'c4'));
  };

  R['find'] = (t, ctx, done) => h('div', { class: 'task' },
    h('div', { class: 'prompt-word' }, h('span', { class: 'lead' }, 'Find the'), h('span', { class: 'en' }, t.word.en), speakBtn(t.word.en)),
    choiceGrid(t.options, o => h('span', { class: 'emo sm' }, o.e), o => o === t.word, ctx, ok => done({ ok }), t.options.length > 9 ? 'scene g4' : 'scene g3'));

  // Конструктор из плиток: нажатие переносит плитку туда-обратно,
  // перетаскивание вставляет её в нужное место или меняет порядок.
  function builder(tokens, mode) {
    const build = h('div', { class: 'build ' + mode });
    const bank = h('div', { class: 'bank ' + mode });
    const cells = [], chips = [], listeners = [];
    let locked = false;
    tokens.forEach((tok, i) => {
      const chip = h('button', { class: 'tile ' + mode, type: 'button', 'data-i': i }, tok);
      const cell = h('span', { class: 'cell' }, chip);
      cells.push(cell); chips.push(chip); bank.append(cell);
      attach(chip);
    });
    const placed = () => [...build.querySelectorAll('.tile[data-i]')];
    const slotGhosts = () => [...build.querySelectorAll('.slot-ghost')];
    function refresh() {
      if (mode === 'letter') {
        slotGhosts().forEach(g => g.remove());
        for (let k = placed().length; k < tokens.length; k++) build.append(h('span', { class: 'slot-ghost', 'aria-hidden': 'true' }));
      }
      build.classList.toggle('empty', !placed().length);
      listeners.forEach(f => f());
    }
    function toBuild(chip, before) {
      const i = +chip.dataset.i;
      if (chip.parentElement === cells[i]) cells[i].replaceChildren(h('span', { class: 'tile hole ' + mode, 'aria-hidden': 'true' }, tokens[i]));
      build.insertBefore(chip, before || slotGhosts()[0] || null);
    }
    function toBank(chip) { cells[+chip.dataset.i].replaceChildren(chip); }
    function tap(chip) {
      if (locked) return;
      if (chip.parentElement === build) toBank(chip); else toBuild(chip);
      refresh();
    }
    function attach(chip) {
      chip.addEventListener('click', e => { if (e.detail === 0) tap(chip); }); // клавиатура
      chip.addEventListener('pointerdown', e => {
        if (locked || e.button > 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        let drag = null;
        const move = ev => {
          if (!drag) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return; drag = start(chip, sx, sy); }
          over(drag, ev);
        };
        const up = ev => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (drag) finish(drag, ev.type === 'pointercancel'); else if (ev.type === 'pointerup') tap(chip);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    }
    function start(chip, sx, sy) {
      const r = chip.getBoundingClientRect();
      const float = chip.cloneNode(true);
      float.classList.add('floating');
      Object.assign(float.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      document.body.append(float);
      chip.classList.add('dragging');
      const ph = h('span', { class: 'tile placeholder ' + mode, style: `width:${r.width}px` });
      return { chip, float, ph, sx, sy, fromBuild: chip.parentElement === build };
    }
    function over(d, ev) {
      d.float.style.transform = `translate(${ev.clientX - d.sx}px, ${ev.clientY - d.sy}px) scale(1.08) rotate(-2deg)`;
      const br = build.getBoundingClientRect();
      const inside = ev.clientX > br.left - 24 && ev.clientX < br.right + 24 && ev.clientY > br.top - 24 && ev.clientY < br.bottom + 24;
      if (!inside) { d.ph.remove(); return; }
      const kids = [...build.children].filter(c => c !== d.ph && c !== d.chip && !c.classList.contains('slot-ghost'));
      const next = kids.find(c => {
        const r = c.getBoundingClientRect();
        if (ev.clientY < r.top) return true;
        return ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2;
      });
      build.insertBefore(d.ph, next || slotGhosts()[0] || null);
    }
    function finish(d, cancelled) {
      d.float.remove();
      d.chip.classList.remove('dragging');
      if (!cancelled && d.ph.isConnected) toBuild(d.chip, d.ph);
      else if (!cancelled && d.fromBuild) toBank(d.chip);
      d.ph.remove();
      refresh();
    }
    refresh();
    return {
      build, bank,
      value: () => placed().map(c => tokens[+c.dataset.i]),
      count: () => placed().length,
      onChange: f => listeners.push(f),
      lock: () => { locked = true; chips.forEach(c => c.disabled = true); },
    };
  }

  function shuffledNotSame(arr) {
    let out = shuffle(arr);
    for (let k = 0; k < 10 && arr.length > 1 && out.join('\u0001') === arr.join('\u0001'); k++) out = shuffle(arr);
    return out;
  }

  const dndHint = () => h('p', { class: 'dnd-hint' }, 'Нажмите на плитку или перетащите её. Порядок можно менять прямо в строке.');

  R['spell'] = (t, ctx, done) => {
    const target = t.word.en;
    const b = builder(shuffledNotSame([...target]), 'letter');
    let finished = false;
    const checkBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => {
      finished = true; b.lock(); checkBtn.disabled = true; giveUp.disabled = true;
      const ok = b.value().join('') === target;
      b.build.classList.add(ok ? 'right' : 'wrong');
      done({ ok });
    } }, 'Проверить');
    b.onChange(() => { checkBtn.disabled = finished || b.count() !== target.length; });
    const giveUp = h('button', { class: 'link', type: 'button', onclick: () => { if (!finished) { finished = true; b.lock(); checkBtn.disabled = true; done({ ok: false }); } } }, 'Не знаю');
    return h('div', { class: 'task' },
      h('div', { class: 'prompt-emoji' }, t.word.e), h('p', { class: 'ru-hint' }, t.word.ru),
      b.build, b.bank, dndHint(), checkBtn, giveUp);
  };

  R['match'] = (t, ctx, done) => {
    const left = shuffle(t.words), right = shuffle(t.words);
    const mistakes = {}; let sel = null, matched = 0;
    const L = left.map(w => h('button', { class: 'mcard emo-card', type: 'button', 'data-en': w.en }, w.e));
    const Rb = right.map(w => h('button', { class: 'mcard', type: 'button', 'data-en': w.en }, w.en));
    function pick(btn, side) {
      if (btn.classList.contains('done')) return;
      if (!sel || sel.side === side) {
        if (sel) sel.btn.classList.remove('sel');
        sel = { btn, side }; btn.classList.add('sel');
        if (side === 'r') speak(btn.dataset.en);
        return;
      }
      const a = sel.btn, b = btn; a.classList.remove('sel'); sel = null;
      if (a.dataset.en === b.dataset.en) {
        a.classList.add('done'); b.classList.add('done'); matched++; speak(a.dataset.en);
        if (matched === t.words.length) {
          const results = t.words.map(w => ({ key: 'v:' + w.en, topic: 'v:' + w.t, ok: !mistakes[w.en] }));
          const bad = Object.values(mistakes).reduce((x, y) => x + y, 0);
          done({ ok: bad <= 1, results, answer: t.words.map(w => `${w.e} ${w.en} — ${w.ru}`).join(' · ') });
        }
      } else {
        const le = side === 'r' ? a.dataset.en : b.dataset.en;
        mistakes[le] = (mistakes[le] || 0) + 1;
        [a, b].forEach(x => { x.classList.add('shake'); setTimeout(() => x.classList.remove('shake'), 400); });
      }
    }
    L.forEach(b => b.addEventListener('click', () => pick(b, 'l')));
    Rb.forEach(b => b.addEventListener('click', () => pick(b, 'r')));
    return h('div', { class: 'task' }, h('div', { class: 'match' }, h('div', { class: 'mcol' }, L), h('div', { class: 'mcol' }, Rb)));
  };

  R['fill'] = (t, ctx, done) => {
    const [a, b] = t.item.s.split('___');
    const blank = h('span', { class: 'blank' }, ' ');
    return h('div', { class: 'task' },
      t.item.e ? h('div', { class: 'prompt-emoji sm' }, t.item.e) : null,
      h('p', { class: 'sentence' }, a, blank, b),
      h('p', { class: 'ru-hint' }, t.item.ru),
      choiceGrid(t.options, o => o, o => o === t.right, ctx, (ok, o) => { blank.textContent = o; blank.classList.add(ok || !ctx.reveal ? 'filled' : 'bad'); done({ ok }); }, 'words'));
  };

  R['order'] = (t, ctx, done) => {
    const words = t.item.w.split(' ');
    const b = builder(shuffledNotSame(words), 'word');
    const checkBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => {
      b.lock(); checkBtn.disabled = true;
      const ok = b.value().join(' ') === t.item.w;
      if (ctx.reveal) b.build.classList.add(ok ? 'right' : 'wrong');
      done({ ok });
    } }, 'Проверить');
    b.onChange(() => { if (!b.build.classList.contains('right') && !b.build.classList.contains('wrong')) checkBtn.disabled = b.count() !== words.length; });
    return h('div', { class: 'task' }, h('p', { class: 'ru-big' }, t.item.ru), b.build, b.bank, dndHint(), checkBtn);
  };

  R['tf'] = (t, ctx, done) => h('div', { class: 'task' },
    h('div', { class: 'prompt-emoji scene-emo' }, t.scene),
    h('p', { class: 'sentence' }, t.s, ' ', speakBtn(t.s)),
    choiceGrid([true, false], o => o ? 'Правда' : 'Неправда', o => o === t.truth, ctx, ok => done({ ok }), 'tf'));

  R['text'] = (t, ctx, done) => h('div', { class: 'task' },
    h('article', { class: 'passage' }, h('div', { class: 'passage-head' }, h('b', {}, t.tx.title), speakBtn(t.tx.text)), h('p', {}, t.tx.text)),
    h('p', { class: 'question' }, t.q.q), h('p', { class: 'ru-hint' }, t.q.qr),
    choiceGrid(t.options, o => o, o => o === t.right, ctx, ok => done({ ok }), 'words stack'));

  // ---------- экраны ----------
  const app = $('#app');
  function show(...nodes) { app.replaceChildren(...nodes); window.scrollTo(0, 0); }
  // Уровни как камни: бронза → серебро → золото → бриллиант
  const gem = (L, cls = '') => h('span', { class: `gem g${L} ${cls}`, 'aria-hidden': 'true' });
  const levelChip = L => h('span', { class: 'lvl' }, gem(L), LEVELS[L].code);

  function topbar() {
    return h('header', { class: 'topbar' },
      h('button', { class: 'brand', type: 'button', onclick: home }, h('span', { class: 'ladder mini', 'aria-hidden': 'true' }, [0, 2, 4, 6].map(L => gem(L))), h('span', { class: 'brand-name' }, 'Ступеньки')),
      h('div', { class: 'stats' },
        h('span', { class: 'stat', title: 'Дней подряд' }, '🔥 ', h('b', {}, S.streak.n)),
        h('span', { class: 'stat', title: 'Очки опыта' }, '★ ', h('b', {}, S.xp)),
        h('button', { class: 'stat sound', type: 'button', title: 'Звук', onclick: e => { S.sound = !S.sound; save(); e.currentTarget.textContent = S.sound ? '🔊' : '🔇'; } }, S.sound ? '🔊' : '🔇'),
        CLOUD ? syncChip() : null));
  }

  const SYNC_TITLES = { idle: 'Облачное сохранение', saving: 'Сохраняем…', saved: 'Прогресс сохранён в облаке', offline: 'Нет связи — прогресс сохранён на устройстве и уйдёт в облако позже', error: 'Не удалось сохранить в облако' };
  function syncChip() {
    if (!profile) return h('button', { class: 'stat sync', type: 'button', onclick: () => loginScreen() }, 'Войти');
    let armed = false, timer;
    const label = h('span', {}, profile.name);
    const b = h('button', { class: 'stat sync', id: 'sync-chip', type: 'button', 'data-state': syncState, title: SYNC_TITLES[syncState] }, h('i', { class: 'sync-dot', 'aria-hidden': 'true' }), label);
    b.addEventListener('click', () => {
      if (armed) return logout();
      armed = true; label.textContent = 'Выйти?';
      clearTimeout(timer);
      timer = setTimeout(() => { armed = false; label.textContent = profile ? profile.name : ''; }, 2500);
    });
    return b;
  }

  function loginScreen(msg) {
    const name = h('input', { id: 'login-name', class: 'field', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Например, Аня', maxlength: '30' });
    const pin = h('input', { id: 'login-pin', class: 'field', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'Не меньше 4 цифр', maxlength: '12' });
    const err = h('p', { class: 'form-err', role: 'alert', hidden: !msg }, msg || '');
    const btn = h('button', { class: 'btn primary xl', type: 'submit' }, 'Войти');
    const fail = text => { btn.disabled = false; btn.textContent = 'Войти'; err.hidden = false; err.textContent = text; };
    const form = h('form', { class: 'panel login' },
      h('h1', {}, 'Кто занимается?'),
      h('p', { class: 'muted' }, 'Имя и PIN нужны, чтобы прогресс сохранялся и открывался с любого устройства. Впервые здесь — профиль создастся сам.'),
      h('label', { for: 'login-name' }, 'Имя'), name,
      h('label', { for: 'login-pin' }, 'PIN-код'), pin,
      err, btn,
      h('button', { class: 'link', type: 'button', onclick: () => home() }, 'Продолжить без входа — прогресс только на этом устройстве'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const n = name.value.trim(), p = pin.value.trim();
      if (!n || !/^\d{4,12}$/.test(p)) return fail('Введите имя и PIN из 4–12 цифр.');
      btn.disabled = true; btn.textContent = 'Входим…';
      // отложенное сохранение прежнего профиля не должно уйти в новый
      clearTimeout(saveTimer); savePending = false;
      let res;
      try { res = await rpc('stupenki_login', { p_name: n, p_pin: p }); }
      catch (x) { return fail('Нет связи с базой. Проверьте интернет или продолжите без входа.'); }
      pin.value = '';
      if (res.status === 'wrong_pin') return fail('Неверный PIN для этого имени.');
      if (res.status === 'locked') return fail(`Слишком много неверных попыток. Вход закрыт ещё на ${Math.ceil((res.seconds || 60) / 60)} мин.`);
      if (res.status === 'limit') return fail('Достигнут лимит профилей — новый создать нельзя.');
      if (!res.token) return fail('Не удалось войти. Попробуйте ещё раз.');
      profile = { name: n, token: res.token };
      storeProfile();
      const remote = normalize(res.data);
      if (remote) { S = remote; saveLocal(); setSync('saved'); }
      else cloudSave(true); // новый профиль: забираем прогресс с этого устройства
      home();
    });
    show(h('main', { class: 'wrap welcome' }, form));
    name.focus();
  }

  function welcome() {
    show(h('main', { class: 'wrap welcome' },
      h('div', { class: 'hero' },
        h('div', { class: 'ladder', 'aria-hidden': 'true' }, LEVELS.map((_, L) => h('div', { class: 'rung', style: `padding-bottom:${L * 12}px` }, gem(L, 'big'), h('span', {}, LEVELS[L].code), h('small', {}, LEVELS[L].name)))),
        h('h1', {}, 'Английский ступенька за ступенькой'),
        h('p', { class: 'lead-p' }, 'Короткие игры с карточками по 5 минут в день. Сначала узнаем ваш уровень, потом тренируем то, что даётся труднее, а выученное повторяем как раз перед тем, как оно начнёт забываться.')),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary xl', type: 'button', onclick: startTest }, 'Узнать мой уровень', h('small', {}, '15 вопросов · около 5 минут')),
        h('button', { class: 'btn ghost xl', type: 'button', onclick: () => { S.onboarded = true; save(); home(); } }, 'Я начинаю с нуля', h('small', {}, 'Сразу к первым словам'))),
      h('ul', { class: 'pillars' },
        h('li', {}, h('b', {}, 'Тест по шкале CEFR'), ' от A0 до C2 — вопросы подстраиваются под ответы'),
        h('li', {}, h('b', {}, '11 форматов-игр'), ' — карточки, поиск на картинке, пары, сборка слов и фраз'),
        h('li', {}, h('b', {}, 'Интервальные повторения'), ' — ошибки возвращаются, выученное не теряется'))));
  }

  function menuBtn(note) {
    let armed = false, timer;
    const b = h('button', { class: 'close', type: 'button', title: note }, h('span', { 'aria-hidden': 'true' }, '←'), ' Меню');
    b.addEventListener('click', () => {
      if (armed) return home();
      armed = true; b.classList.add('armed'); b.lastChild.textContent = ' Выйти?';
      clearTimeout(timer);
      timer = setTimeout(() => { armed = false; b.classList.remove('armed'); b.lastChild.textContent = ' Меню'; }, 2500);
    });
    return b;
  }

  // --- адаптивный тест ---
  function testTask(skill, L, usedTopics, used) {
    const pool = topicsOf(skill).filter(t => TOPICS[t].level === L);
    const fresh = pool.filter(t => !usedTopics.has(t));
    const topic = rand(fresh.length ? fresh : pool);
    usedTopics.add(topic);
    if (skill === 'vocab') return taskFromTopic(topic, used, L >= 4 ? 'meaning' : rand(['pick-emoji', 'pick-word']));
    if (skill === 'grammar') return taskFromTopic(topic, used, 'fill');
    return taskFromTopic(topic, used);
  }

  function startTest() {
    const plan = ['vocab', 'grammar', 'reading', 'vocab', 'grammar', 'reading', 'vocab', 'grammar', 'reading', 'vocab', 'grammar', 'reading', 'vocab', 'grammar', 'reading'];
    S.onboarded = true; save();
    const lv = { vocab: 1, grammar: 1, reading: 1 };
    const log = { vocab: [], grammar: [], reading: [] };
    const usedTopics = new Set(), used = new Set(), results = [];
    let i = 0;
    function step() {
      if (i >= plan.length) return finishTest();
      const skill = plan[i], L = lv[skill];
      const t = testTask(skill, L, usedTopics, used);
      if (!t) { i++; return step(); } // вопросы темы закончились — пропускаем шаг
      t.keys.forEach(k => used.add(k));
      const bar = h('div', { class: 'progress' }, h('i', { style: `width:${(i / plan.length) * 100}%` }));
      let answered = false;
      const onDone = ({ ok }) => {
        if (answered) return; answered = true;
        log[skill].push({ L, ok }); results.push({ topic: t.topic, ok });
        const stepSize = log[skill].length <= 2 ? 2 : 1;
        lv[skill] = ok ? Math.min(MAXL, L + stepSize) : Math.max(0, L - stepSize);
        i++; setTimeout(step, 380);
      };
      show(h('main', { class: 'wrap session' },
        h('div', { class: 'session-head' },
          menuBtn('Прогресс теста не сохранится'), bar,
          h('span', { class: 'count' }, `${i + 1}/${plan.length}`)),
        h('p', { class: 'kind-label' }, h('span', { class: 'skill-tag ' + skill }, SKILLS[skill].name), KINDS[t.kind].ask),
        R[t.kind](t, { reveal: false }, onDone),
        h('button', { class: 'link dunno', type: 'button', onclick: () => onDone({ ok: false }) }, 'Не знаю — пропустить')));
    }
    function finishTest() {
      for (const s of SKILL_IDS) {
        let level = 0;
        for (let L = 0; L <= MAXL; L++) {
          const a = log[s].filter(x => x.L === L); const c = a.filter(x => x.ok).length;
          if (c >= 1 && c / a.length >= 0.5) level = L;
        }
        S.levels[s] = level;
      }
      // карта знаний: темы из теста получают оценку, остальное (накопленное тренировками) не трогаем
      results.forEach(r => {
        if (!r.topic) return;
        const x = S.mastery[r.topic] || { m: 0.45, n: 0 };
        x.m = r.ok ? Math.max(x.m, 0.75) : Math.min(x.m, 0.25);
        x.n = Math.max(1, x.n);
        S.mastery[r.topic] = x;
      });
      S.tested = true; save();
      testResult(results);
    }
    step();
  }

  function skillRows(withBars) {
    return h('div', { class: 'skills' }, SKILL_IDS.map(s => {
      const L = S.levels[s], p = levelProgress(s);
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      const max = L >= MAXL && p.done === p.total;
      return h('div', { class: 'skill-card ' + s, title: `${p.done} из ${p.total} тем уровня освоено` },
        h('div', { class: 'ring-wrap' },
          h('div', { class: 'ring', style: `--p:${withBars ? pct : 100}` }),
          h('div', { class: 'ring-in' }, gem(L), h('b', {}, LEVELS[L].code))),
        h('div', { class: 'skill-meta' },
          h('span', { class: 'skill-name' }, SKILLS[s].name),
          h('span', { class: 'skill-lv' }, LEVELS[L].name),
          withBars ? h('span', { class: 'meter-note' }, max ? 'максимум' : `${p.done} из ${p.total} тем до ${LEVELS[Math.min(MAXL, L + 1)].code}`) : null));
    }));
  }
  function chips(list, cls, empty) {
    if (!list.length) return h('p', { class: 'muted small' }, empty);
    return h('div', { class: 'chips' }, list.slice(0, 6).map(t => h('span', { class: 'chip ' + cls }, h('span', { class: 'skill-dot ' + TOPICS[t].skill }), TOPICS[t].ru, ' ', levelChip(TOPICS[t].level))));
  }

  function testResult(results) {
    const ok = results.filter(r => r.ok).length;
    const { strong, weak } = strongWeak();
    const overall = Math.round(SKILL_IDS.reduce((a, s) => a + S.levels[s], 0) / 3);
    show(topbar(), h('main', { class: 'wrap' },
      h('section', { class: 'result-hero' },
        h('p', { class: 'eyebrow' }, 'Результат теста'),
        h('h1', {}, 'Ваш уровень — ', h('span', { class: 'hl' }, LEVELS[overall].code), ' · ', LEVELS[overall].name),
        h('p', { class: 'muted' }, `Верных ответов: ${ok} из ${results.length}. Ниже — уровень по каждому навыку.`)),
      h('section', { class: 'panel' }, skillRows(false)),
      h('div', { class: 'two' },
        h('section', { class: 'panel' }, h('h3', {}, 'Сильные стороны'), chips(strong, 'good', 'Пока нечего отметить — всё впереди.')),
        h('section', { class: 'panel' }, h('h3', {}, 'Будем тренировать'), chips(weak, 'bad', 'Слабых мест не нашли. Начнём с новых тем.'))),
      h('button', { class: 'btn primary xl', type: 'button', onclick: () => runSession(buildSession(), 'train') }, 'Начать первую тренировку')));
  }

  function home() {
    if (!S.tested && !S.onboarded) return welcome();
    const { strong, weak } = strongWeak();
    const due = dueKeys().length;
    const vocabCards = Object.entries(S.cards).filter(([k]) => k.startsWith('v:'));
    const known = vocabCards.filter(([, c]) => c.box >= 3).length;
    const learning = vocabCards.length - known;
    const doneToday = S.streak.last === todayStr();
    let confirmReset = false;
    const resetBtn = h('button', { class: 'link danger', type: 'button', onclick: () => {
      if (!confirmReset) { confirmReset = true; resetBtn.textContent = 'Точно стереть весь прогресс? Нажмите ещё раз'; return; }
      S = fresh(); save(); welcome();
    } }, 'Сбросить прогресс');

    show(topbar(), h('main', { class: 'wrap' },
      !S.tested ? h('section', { class: 'panel notice' },
        h('div', {}, h('b', {}, 'Тест уровня ещё не пройден'), h('p', { class: 'muted small' }, 'Пока все навыки стоят на A0. Пройдите тест — задания подстроятся под ваш уровень.')),
        h('button', { class: 'btn ghost', type: 'button', onclick: startTest }, 'Пройти тест')) : null,
      h('section', { class: 'today' },
        h('div', {},
          h('p', { class: 'eyebrow' }, doneToday ? 'Цель на сегодня выполнена' : 'Тренировка дня'),
          h('h1', {}, doneToday ? 'Можно ещё один круг' : '10 заданий · около 5 минут'),
          h('p', { class: 'muted' }, due ? `Пора повторить ${due} ${plural(due, 'карточку', 'карточки', 'карточек')} — иначе начнут забываться.` : 'Повторять пока нечего: подберём задания под слабые темы и добавим новое.')),
        h('button', { class: 'btn primary xl', type: 'button', onclick: () => runSession(buildSession(), 'train') }, doneToday ? 'Ещё тренировка' : 'Начать')),

      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Мой уровень'), h('button', { class: 'link', type: 'button', onclick: startTest }, S.tested ? 'Пройти тест заново' : 'Пройти тест уровня')),
        skillRows(true),
        h('div', { class: 'wordstats' },
          h('span', {}, h('b', {}, known), ' ', plural(known, 'слово выучено', 'слова выучено', 'слов выучено')),
          h('span', {}, h('b', {}, learning), ' в процессе'),
          h('span', {}, h('b', {}, WORDS.length), ' всего в словаре'))),

      h('div', { class: 'two' },
        h('section', { class: 'panel' }, h('h3', {}, 'Получается хорошо'), chips(strong, 'good', 'Пройдите пару тренировок — здесь появятся темы, которые даются легко.')),
        h('section', { class: 'panel' }, h('h3', {}, 'Над чем работаем'), chips(weak, 'bad', 'Слабых тем сейчас нет. Отлично!'))),

      h('section', {},
        h('div', { class: 'panel-head' }, h('h2', {}, 'Игры'), h('span', { class: 'muted small' }, 'Задания подбираются под ваш уровень')),
        h('div', { class: 'games' }, Object.entries(KINDS).filter(([k]) => k !== 'listen' || canSpeak()).map(([k, g]) =>
          h('button', { class: 'game ' + g.skill, type: 'button', onclick: () => { const ts = buildGame(k); if (ts.length) runSession(ts, 'game', k); } },
            h('span', { class: 'game-icon' }, g.icon),
            h('span', { class: 'game-name' }, g.name),
            h('span', { class: 'game-note' }, h('span', { class: 'skill-dot ' + g.skill }), g.note))))),

      h('details', { class: 'panel method' },
        h('summary', {}, h('h2', {}, 'Как мы учим')),
        h('div', { class: 'method-body', html: METHOD_HTML })),

      h('footer', { class: 'foot' }, resetBtn)));
  }

  const METHOD_HTML = `
    <p>Тренажёр собран из приёмов, эффективность которых подтверждают исследования памяти.</p>
    <dl>
      <dt>Адаптивная диагностика</dt><dd>Как в тестах Oxford и Cambridge: после верного ответа следующий вопрос сложнее, после ошибки — проще. Уровни считаем по шкале CEFR от A0 до C2, отдельно для слов, грамматики и чтения.</dd>
      <dt>Активное вспоминание</dt><dd>Мы не перечитываем материал, а вспоминаем его: выбираем, находим, собираем. В исследованиях студенты, которые только перечитывали, через два дня забывали 56% материала, а те, кто вспоминал, — лишь 13%.</dd>
      <dt>Интервальные повторения (система Лейтнера)</dt><dd>У каждой карточки есть «коробка». Ответили верно — карточка переезжает дальше, и её повторят через 1, 2, 4, 7, потом 15 дней. Ошиблись — она возвращается в первую коробку.</dd>
      <dt>От узнавания к воспроизведению</dt><dd>Сначала слово нужно узнать среди картинок, потом найти на большой картинке, потом услышать и, наконец, собрать по буквам. Задание становится сложнее по мере того, как вы усваиваете слово.</dd>
      <dt>Фокус на слабом</dt><dd>Примерно 60% тренировки занимают самые слабые темы, 20% — повторение и 20% — новое, на ступеньку выше.</dd>
      <dt>Чередование и работа над ошибками</dt><dd>Форматы и темы идут вперемешку, а ошибки возвращаются в конце тренировки.</dd>
    </dl>`;

  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
    return many;
  }

  // --- проход по заданиям ---
  function runSession(tasks, mode, gameKind) {
    if (!tasks || !tasks.length) return home();
    const queue = tasks.slice();
    let idx = 0, correct = 0, answered = 0;
    const xpStart = S.xp;
    const touched = new Set();
    const levelsBefore = { ...S.levels };

    function next() {
      if (idx >= queue.length) return finish();
      const t = queue[idx];
      const bar = h('div', { class: 'progress' }, h('i', { style: `width:${(idx / queue.length) * 100}%` }));
      const fb = h('div', { class: 'feedback', hidden: true });
      let doneOnce = false;
      const onDone = res => {
        if (doneOnce) return; doneOnce = true;
        const ok = !!res.ok;
        answered++; if (ok) correct++;
        beep(ok);
        const results = res.results || t.keys.map(k => ({ key: k, topic: t.topic, ok }));
        if (!t.keys.length && t.topic) learn(t.topic, ok);
        results.forEach(r => { review(r.key, r.ok); if (r.topic) { learn(r.topic, r.ok); touched.add(r.topic); } });
        if (t.topic) touched.add(t.topic);
        if (ok) S.xp += t.retry ? 5 : 10;
        // ошибка возвращается в конце, в более простом формате
        if (!ok && !t.retry && t.keys.length === 1) {
          const again = taskFromKey(t.keys[0], t.skill === 'vocab' ? (TOPICS[t.topic].level >= 4 ? 'meaning' : 'pick-emoji') : undefined);
          if (again) { again.retry = true; queue.push(again); }
        }
        if (t.say && (ok || t.kind !== 'text')) setTimeout(() => speak(t.say), 200);
        save();
        fb.hidden = false;
        fb.className = 'feedback ' + (ok ? 'ok' : 'bad');
        const answer = res.answer || t.answer;
        fb.replaceChildren(
          h('div', { class: 'fb-text' },
            h('b', {}, ok ? rand(['Верно!', 'Отлично!', 'Так держать!', 'Точно!']) + (t.retry ? ' +5' : ' +10') : 'Почти. Правильный ответ:'),
            answer && (!ok || t.kind === 'match' || t.kind === 'fill' || t.kind === 'order') ? h('span', {}, answer) : null),
          h('button', { class: 'btn ' + (ok ? 'ok' : 'bad'), type: 'button', id: 'next-btn', onclick: () => { idx++; next(); } }, 'Дальше'));
        $('#next-btn').focus({ preventScroll: true });
      };
      show(h('main', { class: 'wrap session' },
        h('div', { class: 'session-head' },
          menuBtn('Ответы уже сохранены'), bar,
          h('span', { class: 'count' }, `${Math.min(idx + 1, queue.length)}/${queue.length}`)),
        h('p', { class: 'kind-label' },
          h('span', { class: 'skill-tag ' + t.skill }, SKILLS[t.skill].name),
          t.retry ? 'Работа над ошибками · ' : '', KINDS[t.kind].ask),
        R[t.kind](t, { reveal: true }, onDone), fb));
    }

    function finish() {
      const today = todayStr();
      if (S.streak.last !== today) {
        const y = todayStr(new Date(Date.now() - DAY));
        S.streak.n = S.streak.last === y ? S.streak.n + 1 : 1;
        S.streak.last = today;
      }
      S.sessions++;
      const ups = checkLevelUps();
      save();
      const pct = answered ? Math.round((correct / answered) * 100) : 0;
      const nextDue = Object.values(S.cards).map(c => c.due).filter(d => d > Date.now()).sort((a, b) => a - b)[0];
      const topicList = [...touched].filter(t => TOPICS[t]);
      show(topbar(), h('main', { class: 'wrap' },
        h('section', { class: 'result-hero' },
          h('p', { class: 'eyebrow' }, mode === 'game' ? KINDS[gameKind].name : 'Тренировка завершена'),
          h('h1', {}, pct >= 80 ? 'Отличный результат!' : pct >= 50 ? 'Хорошая работа!' : 'Каждая ошибка — шаг вперёд'),
          h('div', { class: 'big-stats' },
            h('div', {}, h('b', {}, `${correct}/${answered}`), h('span', {}, 'верных ответов')),
            h('div', {}, h('b', {}, `+${S.xp - xpStart}`), h('span', {}, 'очков опыта')),
            h('div', {}, h('b', {}, `🔥 ${S.streak.n}`), h('span', {}, plural(S.streak.n, 'день подряд', 'дня подряд', 'дней подряд'))))),
        ups.length ? h('section', { class: 'panel levelup' }, h('h3', {}, 'Новая ступенька!'),
          ups.map(s => h('p', {}, `${SKILLS[s].name}: `, levelChip(levelsBefore[s]), ' → ', levelChip(S.levels[s]), ` ${LEVELS[S.levels[s]].name}`))) : null,
        h('section', { class: 'panel' }, h('h3', {}, 'Какие темы тренировали'),
          h('div', { class: 'topic-bars' }, topicList.map(t => h('div', { class: 'tb' },
            h('span', {}, h('span', { class: 'skill-dot ' + TOPICS[t].skill }), TOPICS[t].ru),
            h('div', { class: 'meter' }, h('i', { style: `width:${Math.round(mOf(t) * 100)}%` })),
            h('span', { class: 'tb-pct' }, Math.round(mOf(t) * 100) + '%')))),
          nextDue ? h('p', { class: 'muted small' }, 'Следующее повторение: ', new Date(nextDue).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })) : null),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => mode === 'game' ? runSession(buildGame(gameKind), 'game', gameKind) : runSession(buildSession(), 'train') }, mode === 'game' ? 'Сыграть ещё' : 'Ещё тренировка'),
          h('button', { class: 'btn ghost', type: 'button', onclick: home }, 'На главную'))));
    }
    next();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const b = $('#next-btn'); if (b && document.activeElement !== b) { e.preventDefault(); b.click(); } }
  });
  if (TTS) try { speechSynthesis.getVoices(); } catch (e) {}

  if (CLOUD && profile && profile.pin && !profile.token) migrateLegacyProfile();
  else if (CLOUD && !(profile && profile.token)) loginScreen();
  else { home(); cloudPull(); }
})();
