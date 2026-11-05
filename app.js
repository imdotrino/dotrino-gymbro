// @ts-check
// Lógica de GymBro Timer. Script clásico (no módulo): lo carga index.html al final del <body>.

/**
 * El elemento con ese id. Todos existen en index.html: si falta uno, es un fallo del HTML.
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = id => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`gymbro: missing element #${id}`);
  return el;
};

/** @typedef {'prep' | 'work' | 'rest'} Phase */
/** @typedef {'prep' | 'work' | 'rest' | 'rounds'} CfgKey */
/** @typedef {Record<CfgKey, number>} Config */
/** @typedef {{ phase: Phase, dur: number, round: number }} PhaseStep */

/** @type {Config} */
const DEF = { prep: 10, work: 30, rest: 15, rounds: 8 };
const CFG_KEY = 'gymbro_cfg';
/** @type {Record<CfgKey, { step: number, min: number, max: number }>} */
const LIM = {
  work:   { step: 5, min: 5, max: 900 },
  rest:   { step: 5, min: 0, max: 900 },
  prep:   { step: 5, min: 0, max: 60  },
  rounds: { step: 1, min: 1, max: 99  }
};

let cfg = loadConfig();

/** @returns {Config} */
function loadConfig() {
  try {
    const d = JSON.parse(/** @type {string} */ (localStorage.getItem(CFG_KEY)));
    if (d && typeof d === 'object') return { ...DEF, ...d };
  } catch {}
  return { ...DEF };
}
function saveConfig() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

// Estado del timer persistido. Todo se ancla a timestamps epoch (UTC) para
// que el refresco —o cerrar y volver— descuente el tiempo real transcurrido.
const STATE_KEY = 'gymbro_state';
function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({
    phase: T.phase,
    round: T.round,
    running: T.running,
    finished: T.finished,
    phaseEndTs,        // epoch ms (UTC) en que acaba la fase en curso
    remaining: T.remaining  // segundos restantes si está en pausa
  }));
}
function clearState() { localStorage.removeItem(STATE_KEY); }

// --- Estado del timer ---
/** @type {{ running: boolean, phase: Phase | null, round: number, remaining: number, tickId: ReturnType<typeof setInterval> | null, finished: boolean }} */
const T = {
  running: false,
  phase: null,      // 'prep' | 'work' | 'rest' | null
  round: 0,
  remaining: 0,
  tickId: null,
  finished: false
};

/**
 * @param {number} s segundos
 * @returns {string} mm:ss
 */
function fmt(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

function render() {
  document.body.className = T.phase ? 'phase-' + T.phase : '';

  // Tarjeta de entrenamiento (también muestra la preparación, que la precede)
  const cw = $('cardWork');
  if (T.phase === 'prep') {
    $('labelWork').textContent = 'Preparación';
    $('timeWork').textContent = fmt(T.remaining);
    cw.classList.add('active');
  } else if (T.phase === 'work') {
    $('labelWork').textContent = 'Entrenamiento';
    $('timeWork').textContent = fmt(T.remaining);
    cw.classList.add('active');
  } else {
    $('labelWork').textContent = 'Entrenamiento';
    $('timeWork').textContent = fmt(cfg.work);
    cw.classList.remove('active');
  }

  // Tarjeta de descanso
  const cr = $('cardRest');
  if (T.phase === 'rest') {
    $('timeRest').textContent = fmt(T.remaining);
    cr.classList.add('active');
  } else {
    $('timeRest').textContent = fmt(cfg.rest);
    cr.classList.remove('active');
  }

  // Barra de rondas
  const rb = $('roundBar');
  rb.classList.remove('done');
  if (T.finished) {
    rb.textContent = `💪 ¡Completado! ${cfg.rounds} rondas`;
    rb.classList.add('done');
  } else if (T.phase === 'prep') {
    rb.textContent = '¡Prepárate!';
  } else if (T.phase) {
    rb.textContent = `Ronda ${T.round} / ${cfg.rounds}`;
  } else {
    rb.textContent = 'Listo para entrenar';
  }

  $('btnPlay').innerHTML = T.running ? '⏸ Pausa' : (T.phase ? '▶ Seguir' : '▶ Iniciar');
  $('btnPlay').classList.toggle('paused', T.running);
}

// --- Audio: beeps con WebAudio (sin archivos externos) ---
/** @type {AudioContext | null} */
let actx = null;
/**
 * @param {number} [freq]
 * @param {number} [dur]
 * @param {number} [vol]
 */
function beep(freq = 880, dur = 0.15, vol = 0.5) {
  try {
    if (!actx) actx = new (window.AudioContext || /** @type {typeof AudioContext} */ (window.webkitAudioContext))();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}
function countdownBeep() { beep(880, 0.12, 0.4); }
/** @param {Phase} phase */
function phaseChangeBeep(phase) {
  if (phase === 'work') { beep(660, 0.18); setTimeout(() => beep(990, 0.28), 180); }
  else if (phase === 'rest') { beep(520, 0.25, 0.4); }
  else { beep(440, 0.15); }
}
function finishBeep() {
  beep(880, 0.2); setTimeout(() => beep(1175, 0.2), 220); setTimeout(() => beep(1568, 0.4), 460);
}
/** @param {number | number[]} ms */
function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }

// --- Notificaciones cuando la app NO está en foco ---
// Delegadas al paquete compartido del ecosistema (window.__ccNotif, cableado
// por el <script type="module"> del final). El disparo (SW / new Notification)
// y el permiso los maneja el controlador común.
async function requestNotifications() {
  if (window.__ccNotif) await window.__ccNotif.requestPermission();
}
/**
 * @param {string} title
 * @param {string} body
 */
async function notify(title, body) {
  if (!document.hidden) return; // solo si la app no está visible
  if (!window.__ccNotif) return;
  await window.__ccNotif.notify('phase', {
    title, body, icon: 'icon-192.png', badge: 'icon-192.png',
    tag: 'gymbro', renotify: true, vibrate: [120, 60, 120]
  });
}

// --- Wake lock para mantener la pantalla encendida ---
/** @type {WakeLockSentinel | null} */
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); wakeLock = null; } catch {} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && T.running) requestWakeLock();
});

// --- Secuencia de fases ---
/** @returns {PhaseStep} */
function firstPhase() {
  if (cfg.prep > 0) return { phase: 'prep', dur: cfg.prep, round: 0 };
  return { phase: 'work', dur: cfg.work, round: 1 };
}
/** @returns {PhaseStep | null} */
function nextPhase() {
  if (T.phase === 'prep') return { phase: 'work', dur: cfg.work, round: 1 };
  if (T.phase === 'work') {
    if (T.round >= cfg.rounds) return null;
    if (cfg.rest > 0) return { phase: 'rest', dur: cfg.rest, round: T.round };
    return { phase: 'work', dur: cfg.work, round: T.round + 1 };
  }
  if (T.phase === 'rest') return { phase: 'work', dur: cfg.work, round: T.round + 1 };
  return null;
}
/** @param {PhaseStep | null} f */
function enterPhase(f) {
  if (!f) { finish(); return; }
  T.phase = f.phase;
  T.round = f.round;
  T.remaining = f.dur;
  phaseChangeBeep(f.phase);
  vibrate(f.phase === 'work' ? [120,60,120] : 80);
  if (f.phase === 'work') notify('💪 ¡Entrenamiento!', `Ronda ${f.round} de ${cfg.rounds}`);
  else if (f.phase === 'rest') notify('😮‍💨 Descanso', `Ronda ${f.round} de ${cfg.rounds}`);
  render();
  saveState();
}

function finish() {
  stopTick();
  T.running = false;
  T.phase = null;
  T.round = 0;
  T.remaining = 0;
  T.finished = true;
  releaseWakeLock();
  finishBeep();
  vibrate([200,100,200,100,300]);
  notify('✅ ¡Sesión completada!', `${cfg.rounds} rondas terminadas 💪`);
  render();
  saveState();
}

// --- Bucle por tiempo real (robusto ante throttling) ---
let phaseEndTs = 0;
function stopTick() { if (T.tickId) { clearInterval(T.tickId); T.tickId = null; } }
function startTick() {
  stopTick();
  phaseEndTs = Date.now() + T.remaining * 1000;
  T.tickId = setInterval(tick, 100);
}
function activeTimeEl() { return T.phase === 'rest' ? $('timeRest') : $('timeWork'); }
function tick() {
  const prev = Math.ceil(T.remaining);
  T.remaining = (phaseEndTs - Date.now()) / 1000;
  const now = Math.ceil(T.remaining);
  const el = activeTimeEl();
  if (now !== prev && now <= 3 && now >= 1) {
    countdownBeep();
    el.classList.remove('warn'); void el.offsetWidth; el.classList.add('warn');
  }
  if (T.remaining <= 0) {
    const next = nextPhase();
    if (!next) { finish(); return; }
    enterPhase(next);
    startTick();
    return;
  }
  el.textContent = fmt(T.remaining);
}

function start() {
  if (T.running) return;
  T.finished = false;
  if (!T.phase) enterPhase(firstPhase());
  T.running = true;
  beep(700, 0.05, 0.2); // desbloquea audio en móviles
  requestNotifications();
  requestWakeLock();
  startTick();
  render();
  saveState();
}
function pause() {
  if (!T.running) return;
  stopTick();
  T.running = false;
  releaseWakeLock();
  render();
  saveState();
}
function togglePlay() { T.running ? pause() : start(); }

function reset() {
  stopTick();
  T.running = false;
  T.phase = null;
  T.round = 0;
  T.remaining = 0;
  T.finished = false;
  releaseWakeLock();
  clearState();
  render();
}
function skip() {
  if (!T.phase) return;
  const next = nextPhase();
  if (!next) { finish(); return; }
  enterPhase(next);
  if (T.running) startTick();
}

// --- Ajuste de la BASE configurada (no afecta una fase en curso) ---
/**
 * @param {CfgKey} key
 * @param {number} dir +1 o -1
 */
function adjustBase(key, dir) {
  const l = LIM[key];
  cfg[key] = Math.max(l.min, Math.min(l.max, cfg[key] + dir * l.step));
  saveConfig();
  render();
  paintSteppers();
}

// ¿La tarjeta de `key` corresponde a la fase activa ahora mismo?
// (la tarjeta de entrenamiento también aloja la preparación)
/**
 * @param {CfgKey} key
 * @returns {boolean}
 */
function isActivePhase(key) {
  return (key === 'work' && (T.phase === 'work' || T.phase === 'prep'))
      || (key === 'rest' && T.phase === 'rest');
}

// --- Ajuste EN VIVO del tiempo restante, sin tocar la base ---
/**
 * @param {CfgKey} key
 * @param {number} dir +1 o -1
 */
function adjustLive(key, dir) {
  const delta = dir * LIM[key].step;
  if (T.running) {
    const now = Date.now();
    const rem = Math.max(1, (phaseEndTs - now) / 1000 + delta);
    phaseEndTs = now + rem * 1000;
    T.remaining = rem;
  } else {
    T.remaining = Math.max(1, T.remaining + delta);
  }
  activeTimeEl().textContent = fmt(T.remaining);
  saveState();
}

/**
 * La clave de configuración del contenedor `sel` que envuelve al botón (su `data-key`).
 * @param {HTMLElement} b
 * @param {string} sel
 * @returns {CfgKey}
 */
function keyOf(b, sel) {
  const box = /** @type {HTMLElement | null} */ (b.closest(sel));
  if (!box) throw new Error(`gymbro: button outside ${sel}`);
  return /** @type {CfgKey} */ (box.dataset.key);
}

// --- Eventos: timers en pantalla ---
$('btnPlay').addEventListener('click', togglePlay);
$('btnReset').addEventListener('click', reset);
$('btnSkip').addEventListener('click', skip);
/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.cstepper button')).forEach(b => {
  b.addEventListener('click', () => {
    const key = keyOf(b, '.cstepper');
    const dir = Number(b.dataset.d);
    // Fase en curso (corriendo o en pausa): ajusta el tiempo restante.
    // Si no, ajusta la base configurada.
    if (T.phase && isActivePhase(key)) adjustLive(key, dir);
    else adjustBase(key, dir);
  });
});

// --- Modal (prep + rondas) ---
function openConfig() { paintSteppers(); $('modalConfig').classList.add('open'); }
function closeConfig() { $('modalConfig').classList.remove('open'); }
function estimatedTotal() {
  return cfg.prep + cfg.rounds * cfg.work + Math.max(0, cfg.rounds - 1) * cfg.rest;
}
function paintSteppers() {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#modalConfig .stepper')).forEach(st => {
    const k = /** @type {CfgKey} */ (st.dataset.key);
    const val = st.querySelector('.val');
    if (!val) throw new Error(`gymbro: stepper ${k} without .val`);
    val.textContent = st.dataset.mode === 'sec' ? fmt(cfg[k]) : String(cfg[k]);
  });
  $('totalEst').textContent = fmt(estimatedTotal());
}
/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#modalConfig .stepper button')).forEach(b => {
  b.addEventListener('click', () => {
    adjustBase(keyOf(b, '.stepper'), Number(b.dataset.d));
  });
});
$('btnConfig').addEventListener('click', openConfig);
$('btnClose').addEventListener('click', closeConfig);
$('modalConfig').addEventListener('click', e => {
  if (e.target === $('modalConfig')) closeConfig();
});

// Pone al día el cronómetro tras un refresco: descuenta el tiempo real
// (epoch/UTC) transcurrido y avanza por las fases que hayan vencido mientras
// la página estuvo cerrada, sin emitir sonidos por las fases saltadas.
function catchUp() {
  const now = Date.now();
  while (T.running && T.phase && now >= phaseEndTs) {
    const next = nextPhase();
    if (!next) { finish(); return; }
    T.phase = next.phase;
    T.round = next.round;
    phaseEndTs += next.dur * 1000;
  }
  if (T.running) T.remaining = (phaseEndTs - now) / 1000;
}

function restore() {
  let s = null;
  try { s = JSON.parse(/** @type {string} */ (localStorage.getItem(STATE_KEY))); } catch {}
  if (!s) { render(); return; }
  T.phase = s.phase || null;
  T.round = s.round || 0;
  T.finished = !!s.finished;
  if (s.running && s.phase) {
    phaseEndTs = s.phaseEndTs || Date.now();
    T.running = true;
    catchUp();              // puede terminar la sesión si ya venció todo
    if (T.running) { requestWakeLock(); startTick(); }
  } else if (s.phase) {
    T.remaining = s.remaining || 0;  // estaba en pausa a mitad de fase
  }
  render();
  saveState();
}

// Estado inicial
restore();

// --- PWA: service worker (el botón Instalar lo maneja <dotrino-install>) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
