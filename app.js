/* ============================================================
   RikuyRoad — app.js  (archivo completo)
   Contiene:
     · Constantes y configuración global
     · FSM — Máquina de Estados Finita
     · DOM — Referencias centralizadas
     · CameraManager
     · DetectionEngine (MediaPipe + TF.js + fallback EAR)
     · BlinkBuffer — ventana deslizante 60s
     · EyeClosedTimer — microsueño y escalada
     · AlertSystem — audio (AudioContext) y vibración
     · TripTracker — métricas de sesión
     · HUD — reloj, batería, LED, contador
     · ReducedPhase — temporizador 5s fase amarilla
     · UIController — wiring de botones y FSM
     · PWAInstall — banner "Añadir a pantalla de inicio"
     · Loader — splash + carga de modelos
     · Arranque — DOMContentLoaded
   ============================================================ */

'use strict';

/* ================================================================
   CONSTANTES DE CONFIGURACIÓN
================================================================ */
const CFG = Object.freeze({
  BLINK_WINDOW_MS:            60_000,
  FATIGUE_BLINK_COUNT:        25,
  FATIGUE_CLOSE_MS:           350,
  MICROSLEEP_THRESHOLD_MS:    3_000,
  ESCALATE_AFTER_MS:          3_000,
  REDUCED_CONFIRM_MS:         5_000,
  REDUCED_RECLOSE_MS:         1_500,
  PAUSE_RESET_WINDOW_MS:    120_000,
  PAUSE_MIN_PRESS_MS:           200,
  INFERENCE_INTERVAL_MS:         80,
  MEDIAPIPE_MODEL_URL: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  MEDIAPIPE_WASM_PATH: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  TFJS_MODEL_PATH:     './model/model.json',
  LEFT_EYE_LANDMARKS:  [33, 133, 160, 144],
  RIGHT_EYE_LANDMARKS: [362, 263, 387, 374],
  EYE_PATCH_SIZE:      32,
});

/* ================================================================
   ESTADOS DE LA FSM
================================================================ */
const STATE = Object.freeze({
  IDLE:          'IDLE',
  LOADING:       'LOADING',
  MONITORING:    'MONITORING',
  PREALERT:      'PREALERT',
  ALERT_INITIAL: 'ALERT_INITIAL',
  ALERT_MAX:     'ALERT_MAX',
  REDUCED:       'REDUCED',
  PAUSED:        'PAUSED',
  SUMMARY:       'SUMMARY',
  ERROR:         'ERROR',
});

/* ================================================================
   FSM — Máquina de Estados Finita
================================================================ */
const fsm = (() => {
  let _current   = STATE.IDLE;
  let _enteredAt = Date.now();
  const _listeners = [];

  return {
    get current()   { return _current; },
    get enteredAt() { return _enteredAt; },

    onChange(fn) { _listeners.push(fn); },

    transition(newState, payload = {}) {
      if (newState === _current) return;
      if (!Object.values(STATE).includes(newState)) {
        console.error('[FSM] Estado desconocido:', newState);
        return;
      }
      const prev = _current;
      _current   = newState;
      _enteredAt = Date.now();
      console.log(`[FSM] ${prev} → ${newState}`);
      _listeners.forEach((fn) => {
        try { fn(newState, prev, payload); }
        catch (e) { console.error('[FSM] Error en listener:', e); }
      });
    },

    timeInState() { return Date.now() - _enteredAt; },
  };
})();

/* ================================================================
   REFERENCIAS DOM
================================================================ */
const DOM = {
  screens: {
    splash:     document.getElementById('screen-splash'),
    idle:       document.getElementById('screen-idle'),
    monitoring: document.getElementById('screen-monitoring'),
    paused:     document.getElementById('screen-paused'),
    summary:    document.getElementById('screen-summary'),
    error:      document.getElementById('screen-error'),
  },
  splashStatus:           document.getElementById('splash-status-text'),
  splashBar:              document.getElementById('splash-progress-bar'),
  splashBarWrap:          document.getElementById('splash-progress-bar-wrap'),
  btnStart:               document.getElementById('btn-start'),
  installBanner:          document.getElementById('install-banner'),
  btnInstall:             document.getElementById('btn-install'),
  btnDismissInstall:      document.getElementById('btn-dismiss-install'),
  video:                  document.getElementById('camera-video'),
  hudLed:                 document.getElementById('hud-led'),
  hudClock:               document.getElementById('hud-clock'),
  hudBatteryIcon:         document.getElementById('hud-battery-icon'),
  hudBatteryLvl:          document.getElementById('hud-battery-level'),
  hudMicrosleep:          document.getElementById('hud-microsleep-count'),
  btnPause:               document.getElementById('btn-pause'),
  btnEndTrip:             document.getElementById('btn-end-trip'),
  overlayPrealert:        document.getElementById('overlay-prealert'),
  overlayAlertInitial:    document.getElementById('overlay-alert-initial'),
  overlayAlertMax:        document.getElementById('overlay-alert-max'),
  overlayReduced:         document.getElementById('overlay-reduced'),
  overlayRecommendations: document.getElementById('overlay-recommendations'),
  reducedTimer:           document.getElementById('reduced-timer'),
  btnUnderstood:          document.getElementById('btn-understood'),
  btnAwake:               document.getElementById('btn-awake'),
  btnRecClose:            document.getElementById('btn-rec-close'),
  recIcon:                document.getElementById('rec-icon'),
  recTitle:               document.getElementById('rec-title'),
  recBody:                document.getElementById('rec-body'),
  pausedClock:            document.getElementById('paused-clock'),
  pausedBattery:          document.getElementById('paused-battery'),
  pausedTripTime:         document.getElementById('paused-trip-time'),
  btnResume:              document.getElementById('btn-resume'),
  summaryDuration:        document.getElementById('summary-duration'),
  summaryMicrosleeps:     document.getElementById('summary-microsleeps'),
  summaryPrealerts:       document.getElementById('summary-prealerts'),
  btnSummaryClose:        document.getElementById('btn-summary-close'),
  errorTitle:             document.getElementById('error-title'),
  errorBody:              document.getElementById('error-body'),
  btnRetry:               document.getElementById('btn-retry'),
};

/* ----------------------------------------------------------------
   Helpers de pantalla y overlays
---------------------------------------------------------------- */
function showScreen(name) {
  Object.entries(DOM.screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

function showOverlay(el)  { el && el.classList.add('visible'); }
function hideOverlay(el)  { el && el.classList.remove('visible'); }

function hideAllAlertOverlays() {
  [
    DOM.overlayPrealert,
    DOM.overlayAlertInitial,
    DOM.overlayAlertMax,
    DOM.overlayReduced,
  ].forEach(hideOverlay);
}

/* ================================================================
   CAMERA MANAGER
================================================================ */
const cameraManager = (() => {
  let _stream = null;
  let _active = false;

  return {
    get active() { return _active; },

    async start() {
      if (_stream) this.stop();
      try {
        _stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width:      { ideal: 640 },
            height:     { ideal: 480 },
            frameRate:  { ideal: 30, min: 15 },
          },
          audio: false,
        });
      } catch (err) {
        _active = false;
        throw err;
      }
      DOM.video.srcObject = _stream;
      await new Promise((resolve, reject) => {
        DOM.video.onloadedmetadata = resolve;
        DOM.video.onerror = reject;
      });
      await DOM.video.play().catch(() => {});
      _active = true;
      return DOM.video;
    },

    stop() {
      if (_stream) {
        _stream.getTracks().forEach((t) => t.stop());
        _stream = null;
      }
      DOM.video.srcObject = null;
      _active = false;
    },

    freeze() {
      if (_stream) _stream.getTracks().forEach((t) => { t.enabled = false; });
      _active = false;
    },

    unfreeze() {
      if (_stream) _stream.getTracks().forEach((t) => { t.enabled = true; });
      _active = true;
    },
  };
})();

/* ================================================================
   DETECTION ENGINE
   MediaPipe FaceLandmarker + TF.js eye classifier + EAR fallback
================================================================ */
const detectionEngine = (() => {
  let _faceLandmarker  = null;
  let _eyeModel        = null;
  let _running         = false;
  let _rafId           = null;
  let _lastInferenceTs = 0;
  let _resultCb        = null;

  const _canvas = document.createElement('canvas');
  const _ctx    = _canvas.getContext('2d', { willReadFrequently: true });
  _canvas.width = _canvas.height = CFG.EYE_PATCH_SIZE;

  /* ---- Esperar a que los scripts CDN hayan cargado ---- */
  function _waitForLibs() {
  return new Promise((resolve) => {
    const check = () => {
      const tfOk = typeof window.tf              !== 'undefined';
      const mpOk = typeof window.FaceLandmarker  !== 'undefined'
                && typeof window.FilesetResolver  !== 'undefined';
      if (tfOk && mpOk) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

  /* ---- Inicialización ---- */
  async function init(onProgress) {
    const progress = onProgress || (() => {});
    progress(5, 'Cargando librerías…');
    await _waitForLibs();

    progress(20, 'Inicializando detección facial…');
    const { FaceLandmarker, FilesetResolver } = window;

    const vision = await FilesetResolver.forVisionTasks(CFG.MEDIAPIPE_WASM_PATH);

    progress(45, 'Descargando modelo facial…');
    _faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: CFG.MEDIAPIPE_MODEL_URL,
        delegate: 'GPU',
      },
      runningMode:                    'VIDEO',
      numFaces:                       1,
      minFaceDetectionConfidence:     0.5,
      minFacePresenceConfidence:      0.5,
      minTrackingConfidence:          0.5,
      outputFaceBlendshapes:          false,
      outputFacialTransformationMatrixes: false,
    });

    /* Cachear assets de MediaPipe en SW */
    _cacheInSW([
      CFG.MEDIAPIPE_MODEL_URL,
      CFG.MEDIAPIPE_WASM_PATH + '/vision_wasm_internal.js',
      CFG.MEDIAPIPE_WASM_PATH + '/vision_wasm_internal.wasm',
      CFG.MEDIAPIPE_WASM_PATH + '/vision_wasm_nosimd_internal.js',
      CFG.MEDIAPIPE_WASM_PATH + '/vision_wasm_nosimd_internal.wasm',
    ]);

    progress(70, 'Cargando modelo de ojos…');
    try {
      _eyeModel = await tf.loadLayersModel(CFG.TFJS_MODEL_PATH);
      const dummy = tf.zeros([1, CFG.EYE_PATCH_SIZE, CFG.EYE_PATCH_SIZE, 1]);
      await _eyeModel.predict(dummy).data();
      dummy.dispose();
    } catch (e) {
      console.warn('[DetectionEngine] Modelo TF.js no disponible, usando EAR:', e.message);
      _eyeModel = null;
    }

    progress(100, '¡Todo listo!');
    return true;
  }

  function _cacheInSW(urls) {
    if (!navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_URLS', urls });
  }

  /* ---- Bucle de inferencia ---- */
  function start(callback) {
    if (_running) stop();
    _resultCb = callback;
    _running  = true;
    _loop();
  }

  function stop() {
    _running = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }

  function _loop() {
    if (!_running) return;
    _rafId = requestAnimationFrame(async (ts) => {
      if (ts - _lastInferenceTs >= CFG.INFERENCE_INTERVAL_MS) {
        _lastInferenceTs = ts;
        try { await _processFrame(ts); } catch (e) { /* continuar */ }
      }
      _loop();
    });
  }

  async function _processFrame(ts) {
    const v = DOM.video;
    if (!v || v.readyState < 2 || v.paused || v.ended) return;

    const result = _faceLandmarker.detectForVideo(v, ts);

    if (!result?.faceLandmarks?.length) {
      _resultCb?.({ faceDetected: false, bothClosed: false,
                    leftClosed: false, rightClosed: false });
      return;
    }

    const pts = result.faceLandmarks[0];
    let leftClosed, rightClosed;

    if (_eyeModel) {
      [leftClosed, rightClosed] = await _classifyModel(v, pts);
    } else {
      [leftClosed, rightClosed] = _classifyEAR(pts);
    }

    _resultCb?.({
      faceDetected: true,
      bothClosed:   leftClosed && rightClosed,
      leftClosed,
      rightClosed,
    });
  }

  /* ---- Clasificación con TF.js ---- */
  async function _classifyModel(video, pts) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const lp = _extractPatch(video, pts, CFG.LEFT_EYE_LANDMARKS,  vw, vh);
    const rp = _extractPatch(video, pts, CFG.RIGHT_EYE_LANDMARKS, vw, vh);
    const [ls, rs] = await Promise.all([_inferEye(lp), _inferEye(rp)]);
    return [ls > 0.5, rs > 0.5];
  }

  function _extractPatch(video, pts, idxs, vw, vh) {
    const xs = idxs.map((i) => pts[i].x * vw);
    const ys = idxs.map((i) => pts[i].y * vh);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const px = (xMax - xMin) * 0.3, py = (yMax - yMin) * 0.5;
    const sx = Math.max(0, xMin - px);
    const sy = Math.max(0, yMin - py);
    const sw = Math.min(vw - sx, (xMax - xMin) + px * 2);
    const sh = Math.min(vh - sy, (yMax - yMin) + py * 2);
    _ctx.drawImage(video, sx, sy, sw, sh, 0, 0, CFG.EYE_PATCH_SIZE, CFG.EYE_PATCH_SIZE);
    return _ctx.getImageData(0, 0, CFG.EYE_PATCH_SIZE, CFG.EYE_PATCH_SIZE);
  }

  async function _inferEye(imageData) {
    return tf.tidy(() => {
      const rgba    = tf.browser.fromPixels(imageData, 4);
      const gray    = rgba.mean(2).expandDims(2);
      const norm    = gray.div(255.0);
      const batched = norm.expandDims(0);
      return _eyeModel.predict(batched).dataSync()[0];
    });
  }

  /* ---- Fallback EAR ---- */
  function _classifyEAR(pts) {
    const EAR_THRESHOLD = 0.20;
    return [
      _ear(pts, [33, 160, 158, 133, 153, 144]) < EAR_THRESHOLD,
      _ear(pts, [362, 385, 387, 263, 373, 374]) < EAR_THRESHOLD,
    ];
  }

  function _ear(pts, [p1, p2, p3, p4, p5, p6]) {
    const d = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
    return (d(p2, p6) + d(p3, p5)) / (2.0 * d(p1, p4));
  }

  return { init, start, stop };
})();

/* ================================================================
   BLINK BUFFER — ventana deslizante 60 s
================================================================ */
const blinkBuffer = (() => {
  let _entries       = [];
  let _closedSince   = null;

  return {
    update(bothClosed) {
      const now = Date.now();
      if (bothClosed && _closedSince === null) {
        _closedSince = now;
      } else if (!bothClosed && _closedSince !== null) {
        const dur = now - _closedSince;
        if (dur >= 50 && dur < CFG.MICROSLEEP_THRESHOLD_MS) {
          _entries.push({ closedAt: _closedSince, durationMs: dur });
        }
        _closedSince = null;
      }
      this._prune();
    },

    get continuousClosedMs() {
      return _closedSince ? Date.now() - _closedSince : 0;
    },

    isFatigued() {
      this._prune();
      if (_entries.length <= CFG.FATIGUE_BLINK_COUNT) return false;
      const avg = _entries.reduce((s, e) => s + e.durationMs, 0) / _entries.length;
      return avg > CFG.FATIGUE_CLOSE_MS;
    },

    reset()  { _entries = []; _closedSince = null; },
    freeze() { _closedSince = null; },

    _prune() {
      const cutoff = Date.now() - CFG.BLINK_WINDOW_MS;
      _entries = _entries.filter((e) => e.closedAt >= cutoff);
    },
  };
})();

/* ================================================================
   EYE CLOSED TIMER — microsueño y escalada
================================================================ */
const eyeClosedTimer = (() => {
  let _closedSince    = null;
  let _alertAt        = null;
  let _alertActive    = false;

  return {
    update(bothClosed) {
      const now    = Date.now();
      const events = { microsleepDetected: false, escalateToMax: false, eyesOpened: false };

      if (bothClosed) {
        if (_closedSince === null) _closedSince = now;
        const ms = now - _closedSince;

        if (!_alertActive && ms >= CFG.MICROSLEEP_THRESHOLD_MS) {
          events.microsleepDetected = true;
          _alertActive = true;
          _alertAt     = now;
        }
        if (_alertActive && _alertAt && (now - _alertAt) >= CFG.ESCALATE_AFTER_MS) {
          events.escalateToMax = true;
          _alertAt = null;
        }
      } else {
        if (_closedSince !== null) events.eyesOpened = true;
        _closedSince = null;
        _alertActive = false;
        _alertAt     = null;
      }
      return events;
    },

    reset() { _closedSince = null; _alertAt = null; _alertActive = false; },
  };
})();

/* ================================================================
   ALERT SYSTEM — AudioContext + vibración
================================================================ */
const alertSystem = (() => {
  let _ctx          = null;
  let _oscNode      = null;
  let _gainNode     = null;
  let _strobeTimer  = null;
  let _softTimer    = null;
  let _vibrateTimer = null;

  function _ensureCtx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }

  function _beep(freq = 880, ms = 200, vol = 0.8, type = 'sine') {
    try {
      const ctx  = _ensureCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type; osc.frequency.value = freq;
      gain.gain.value = 0;
      osc.connect(gain); gain.connect(ctx.destination);
      const t = ctx.currentTime;
      gain.gain.linearRampToValueAtTime(vol,  t + 0.01);
      gain.gain.linearRampToValueAtTime(0,    t + ms / 1000 - 0.01);
      osc.start(t); osc.stop(t + ms / 1000);
    } catch (_) {}
  }

  function _startContinuous(freq, vol = 1.0) {
    _stopContinuous();
    try {
      const ctx = _ensureCtx();
      _oscNode  = ctx.createOscillator();
      _gainNode = ctx.createGain();
      _oscNode.type = 'square'; _oscNode.frequency.value = freq;
      _gainNode.gain.value = vol;
      _oscNode.connect(_gainNode); _gainNode.connect(ctx.destination);
      _oscNode.start();
    } catch (_) {}
  }

  function _stopContinuous() {
    try { _oscNode?.stop(); _oscNode?.disconnect(); _gainNode?.disconnect(); } catch (_) {}
    _oscNode = null; _gainNode = null;
  }

  function _vibrate(pattern) {
    try { navigator.vibrate?.(pattern); } catch (_) {}
  }

  function _startVibrateLoop(pattern, every) {
    _stopVibrateLoop();
    _vibrate(pattern);
    _vibrateTimer = setInterval(() => _vibrate(pattern), every);
  }

  function _stopVibrateLoop() {
    clearInterval(_vibrateTimer); _vibrateTimer = null;
    try { navigator.vibrate?.(0); } catch (_) {}
  }

  function _stopStrobe()  { clearInterval(_strobeTimer); _strobeTimer = null; }
  function _stopSoft()    { clearInterval(_softTimer);   _softTimer   = null; }

  /* ---- API pública ---- */

  function startPrealert() {
    _beep(880, 200, 0.7, 'sine');
  }

  function startAlertInitial() {
    _stopStrobe(); _stopSoft();
    _startContinuous(1100, 1.0);
    _startVibrateLoop([2000], 2500);
  }

  function startAlertMax() {
    _stopContinuous(); _stopSoft();
    _strobeTimer = setInterval(() => _beep(1400, 55, 1.0, 'square'), 100);
    _startVibrateLoop([100, 50, 100, 50, 100, 50, 100, 50], 700);
  }

  function startReduced() {
    _stopContinuous(); _stopStrobe();
    _beep(660, 300, 0.35, 'sine');
    _softTimer = setInterval(() => _beep(660, 300, 0.35, 'sine'), 2000);
    _stopVibrateLoop();
    _vibrate([100]);
    _vibrateTimer = setInterval(() => _vibrate([100]), 2000);
  }

  function stopAll() {
    _stopContinuous(); _stopStrobe(); _stopSoft(); _stopVibrateLoop();
  }

  function resume() { _ctx?.resume().catch(() => {}); }

  return { startPrealert, startAlertInitial, startAlertMax, startReduced, stopAll, resume };
})();

/* ================================================================
   TRIP TRACKER — métricas de sesión
================================================================ */
const tripTracker = (() => {
  let _startTime     = null;
  let _microsleeps   = 0;
  let _prealerts     = 0;
  let _pauseStart    = null;
  let _totalPausedMs = 0;

  return {
    start() {
      _startTime = Date.now();
      _microsleeps = _prealerts = _totalPausedMs = 0;
      _pauseStart = null;
    },

    recordMicrosleep() { _microsleeps++; },
    recordPrealert()   { _prealerts++;   },

    pauseBegin() { if (!_pauseStart) _pauseStart = Date.now(); },

    pauseEnd() {
      if (_pauseStart) { _totalPausedMs += Date.now() - _pauseStart; _pauseStart = null; }
    },

    get currentPauseMs()  { return _pauseStart ? Date.now() - _pauseStart : 0; },
    get microsleepCount() { return _microsleeps; },
    get prealertCount()   { return _prealerts;   },

    get elapsedMs() {
      if (!_startTime) return 0;
      const paused = _totalPausedMs + (_pauseStart ? Date.now() - _pauseStart : 0);
      return Date.now() - _startTime - paused;
    },

    formatElapsed() { return _fmtDuration(this.elapsedMs); },

    getSummary() {
      return {
        duration:    this.formatElapsed(),
        microsleeps: _microsleeps,
        prealerts:   _prealerts,
      };
    },
  };
})();

function _fmtDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(min).padStart(2,'0')}`;
  return `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/* ================================================================
   HUD — reloj, batería, LED, microsueños
================================================================ */
const hud = (() => {
  let _timer = null;

  function _clock() {
    const t = new Date().toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit', hour12:false });
    if (DOM.hudClock)    DOM.hudClock.textContent    = t;
    if (DOM.pausedClock) DOM.pausedClock.textContent = t;
  }

  async function _battery() {
    if (!navigator.getBattery) return;
    try {
      const bat = await navigator.getBattery();
      const pct = Math.round(bat.level * 100);
      const icon = bat.charging ? '🔌' : pct > 60 ? '🔋' : pct > 20 ? '🪫' : '🔴';
      if (DOM.hudBatteryIcon) DOM.hudBatteryIcon.textContent = icon;
      if (DOM.hudBatteryLvl)  DOM.hudBatteryLvl.textContent  = pct + '%';
      if (DOM.pausedBattery)  DOM.pausedBattery.textContent  = 'Batería: ' + pct + '%';
    } catch (_) {}
  }

  function tick() {
    _clock();
    _battery();
    if (DOM.hudMicrosleep) DOM.hudMicrosleep.textContent = tripTracker.microsleepCount;
    if (DOM.pausedTripTime) DOM.pausedTripTime.textContent = 'Tiempo de viaje: ' + tripTracker.formatElapsed();
  }

  function setLed(color) {
    if (!DOM.hudLed) return;
    DOM.hudLed.classList.remove('orange', 'red');
    if (color === 'orange') DOM.hudLed.classList.add('orange');
    if (color === 'red')    DOM.hudLed.classList.add('red');
  }

  function start() {
    if (_timer) return;
    tick();
    _timer = setInterval(tick, 1000);
  }

  function stop() { clearInterval(_timer); _timer = null; }

  return { start, stop, setLed, tick };
})();

/* ================================================================
   REDUCED PHASE CONTROLLER — temporizador 5 s fase amarilla
================================================================ */
const reducedPhase = (() => {
  let _countdownTimer = null;
  let _timeoutTimer   = null;
  let _reclosedAt     = null;
  let _secsLeft       = 5;
  let _active         = false;
  let _onConfirmed    = null;
  let _onEscalate     = null;

  function _render() {
    if (!DOM.reducedTimer) return;
    DOM.reducedTimer.textContent = Math.max(0, _secsLeft);
    DOM.reducedTimer.classList.toggle('urgent', _secsLeft <= 2);
  }

  function start(onConfirmed, onEscalate) {
    _active       = true;
    _secsLeft     = Math.ceil(CFG.REDUCED_CONFIRM_MS / 1000);
    _reclosedAt   = null;
    _onConfirmed  = onConfirmed;
    _onEscalate   = onEscalate;
    _render();

    _countdownTimer = setInterval(() => {
      _secsLeft = Math.max(0, _secsLeft - 1);
      _render();
    }, 1000);

    _timeoutTimer = setTimeout(() => {
      if (!_active) return;
      _cleanup();
      _onEscalate?.('timeout');
    }, CFG.REDUCED_CONFIRM_MS);
  }

  function updateEyeState(bothClosed) {
    if (!_active) return;
    const now = Date.now();
    if (bothClosed) {
      if (!_reclosedAt) _reclosedAt = now;
      if (now - _reclosedAt >= CFG.REDUCED_RECLOSE_MS) {
        _cleanup();
        _onEscalate?.('reclose');
      }
    } else {
      _reclosedAt = null;
    }
  }

  function confirm() {
    if (!_active) return;
    _cleanup();
    _onConfirmed?.();
  }

  function _cleanup() {
    _active = false;
    clearInterval(_countdownTimer); _countdownTimer = null;
    clearTimeout(_timeoutTimer);    _timeoutTimer   = null;
    _reclosedAt = null;
  }

  return { start, stop: _cleanup, confirm, updateEyeState, get active() { return _active; } };
})();

/* ================================================================
   UI CONTROLLER — wiring de botones y lógica de la FSM
================================================================ */
const uiController = (() => {

  /* ----------------------------------------------------------
     Callback principal del motor de detección
  ---------------------------------------------------------- */
  function onDetectionResult({ faceDetected, bothClosed }) {
    const state = fsm.current;

    /* Actualizar buffer de parpadeo */
    if (state === STATE.MONITORING || state === STATE.PREALERT) {
      blinkBuffer.update(bothClosed);
    }

    /* LED */
    if (state === STATE.MONITORING) {
      hud.setLed(!faceDetected ? 'orange' : bothClosed ? 'red' : 'green');
    }

    /* Fase reducida: vigilar re-cierre */
    if (state === STATE.REDUCED) {
      reducedPhase.updateEyeState(bothClosed);
      return;
    }

    /* En alertas: si abre los ojos → fase reducida */
    if ((state === STATE.ALERT_INITIAL || state === STATE.ALERT_MAX) && !bothClosed) {
      fsm.transition(STATE.REDUCED);
      return;
    }

    /* Solo lógica de detección en MONITORING */
    if (state !== STATE.MONITORING) return;

    /* Evaluar microsueño */
    const ev = eyeClosedTimer.update(bothClosed);
    if (ev.microsleepDetected) {
      fsm.transition(STATE.ALERT_INITIAL);
      return;
    }

    /* Evaluar fatiga (ventana deslizante) */
    if (!bothClosed && blinkBuffer.isFatigued()) {
      fsm.transition(STATE.PREALERT);
    }
  }

  /* ----------------------------------------------------------
     Transiciones de estado — efectos de entrada/salida
  ---------------------------------------------------------- */
  fsm.onChange(async (newState, prevState) => {

    /* Ocultar todos los overlays de alerta al cambiar de estado,
       excepto si vamos a mostrar uno específico a continuación */
    if (newState !== STATE.PREALERT &&
        newState !== STATE.ALERT_INITIAL &&
        newState !== STATE.ALERT_MAX &&
        newState !== STATE.REDUCED) {
      hideAllAlertOverlays();
    }

    switch (newState) {

      /* ---- MONITORING ---- */
      case STATE.MONITORING: {
        alertSystem.stopAll();
        reducedPhase.stop();
        hideAllAlertOverlays();
        hideOverlay(DOM.overlayRecommendations);

        /* Volvemos de PAUSA */
        if (prevState === STATE.PAUSED) {
          const pausedMs = tripTracker.currentPauseMs;
          tripTracker.pauseEnd();
          if (pausedMs > CFG.PAUSE_RESET_WINDOW_MS) {
            blinkBuffer.reset();
          }
          try {
            await cameraManager.start();
          } catch (err) {
            _handleCameraError(err);
            return;
          }
        }

        showScreen('monitoring');
        eyeClosedTimer.reset();
        hud.setLed('green');
        DOM.btnEndTrip.disabled = false;
        DOM.btnPause.classList.remove('hidden');
        DOM.btnPause.textContent  = '⏸';
        DOM.btnPause.ariaLabel    = 'Pausar monitoreo';

        detectionEngine.stop();
        detectionEngine.start(onDetectionResult);
        hud.start();
        break;
      }

      /* ---- PREALERT ---- */
      case STATE.PREALERT: {
        alertSystem.startPrealert();
        tripTracker.recordPrealert();
        hud.setLed('orange');
        DOM.btnEndTrip.disabled = true;
        showOverlay(DOM.overlayPrealert);
        /* Detección sigue activa en segundo plano */
        break;
      }

      /* ---- ALERT_INITIAL ---- */
      case STATE.ALERT_INITIAL: {
        hideAllAlertOverlays();
        alertSystem.startAlertInitial();
        hud.setLed('red');
        DOM.btnEndTrip.disabled = true;
        DOM.btnPause.classList.add('hidden');
        showOverlay(DOM.overlayAlertInitial);

        /* Temporizador de escalada a máxima (+3 s) */
        setTimeout(() => {
          if (fsm.current === STATE.ALERT_INITIAL) {
            fsm.transition(STATE.ALERT_MAX);
          }
        }, CFG.ESCALATE_AFTER_MS);
        break;
      }

      /* ---- ALERT_MAX ---- */
      case STATE.ALERT_MAX: {
        hideAllAlertOverlays();
        alertSystem.startAlertMax();
        hud.setLed('red');
        DOM.btnEndTrip.disabled = true;
        DOM.btnPause.classList.add('hidden');
        showOverlay(DOM.overlayAlertMax);
        break;
      }

      /* ---- REDUCED ---- */
      case STATE.REDUCED: {
        hideAllAlertOverlays();
        alertSystem.startReduced();
        hud.setLed('orange');
        DOM.btnEndTrip.disabled = true;
        showOverlay(DOM.overlayReduced);

        reducedPhase.start(
          /* onConfirmed */ () => {
            alertSystem.stopAll();
            tripTracker.recordMicrosleep();
            hud.tick();
            _showRecommendations();
          },
          /* onEscalate */ (reason) => {
            console.log('[Reduced] Escalando:', reason);
            fsm.transition(STATE.ALERT_MAX);
          }
        );
        break;
      }

      /* ---- PAUSED ---- */
      case STATE.PAUSED: {
        alertSystem.stopAll();
        reducedPhase.stop();
        detectionEngine.stop();
        blinkBuffer.freeze();
        eyeClosedTimer.reset();
        tripTracker.pauseBegin();

        /* Liberar cámara completamente en pausa */
        cameraManager.stop();

        showScreen('paused');
        hud.start();
        DOM.btnPause.textContent = '▶';
        DOM.btnPause.ariaLabel   = 'Reanudar monitoreo';
        break;
      }

      /* ---- SUMMARY ---- */
      case STATE.SUMMARY: {
        alertSystem.stopAll();
        reducedPhase.stop();
        detectionEngine.stop();
        cameraManager.stop();
        hud.stop();
        eyeClosedTimer.reset();
        blinkBuffer.reset();

        const s = tripTracker.getSummary();
        DOM.summaryDuration.textContent    = s.duration;
        DOM.summaryMicrosleeps.textContent = s.microsleeps;
        DOM.summaryPrealerts.textContent   = s.prealerts;
        DOM.summaryMicrosleeps.className   =
          'stat-value' + (s.microsleeps > 2 ? ' danger' : s.microsleeps > 0 ? ' warning' : '');

        showScreen('summary');
        break;
      }

      /* ---- IDLE ---- */
      case STATE.IDLE: {
        alertSystem.stopAll();
        detectionEngine.stop();
        cameraManager.stop();
        hud.stop();
        showScreen('idle');
        break;
      }

      /* ---- ERROR ---- */
      case STATE.ERROR: {
        alertSystem.stopAll();
        detectionEngine.stop();
        cameraManager.stop();
        hud.stop();
        showScreen('error');
        break;
      }
    }
  });

  /* ----------------------------------------------------------
     Overlay de recomendaciones post-microsueño
  ---------------------------------------------------------- */
  function _showRecommendations() {
    hideAllAlertOverlays();
    const count = tripTracker.microsleepCount;

    DOM.overlayRecommendations.className =
      count === 1 ? 'visible level-1' : 'visible level-2';

    if (count === 1) {
      DOM.recIcon.textContent  = '😴';
      DOM.recTitle.textContent = 'Detectamos un microsueño';
      DOM.recBody.textContent  =
        'Tu cuerpo necesita descanso. Para en un lugar seguro y '
        + 'duerme al menos 20 minutos o toma un café antes de continuar.';
    } else {
      DOM.recIcon.textContent  = '🚨';
      DOM.recTitle.textContent = '¡Está poniendo vidas en peligro!';
      DOM.recBody.textContent  =
        'Ya llevas ' + count + ' microsueños en este viaje. '
        + 'Detente AHORA. Conducir así es tan peligroso como hacerlo en estado de ebriedad.';
    }

    showOverlay(DOM.overlayRecommendations);
  }

  /* ----------------------------------------------------------
     Manejo de errores de cámara
  ---------------------------------------------------------- */
  function _handleCameraError(err) {
    console.error('[Camera] Error:', err);
    const msgs = {
      NotFoundError:       ['Cámara no encontrada',   'No se detectó ninguna cámara frontal en tu dispositivo.'],
      DevicesNotFoundError:['Cámara no encontrada',   'No se detectó ninguna cámara frontal en tu dispositivo.'],
      NotAllowedError:     ['Permiso denegado',        'Debes permitir el acceso a la cámara. Ve a Ajustes → Privacidad → Cámara.'],
      PermissionDeniedError:['Permiso denegado',       'Debes permitir el acceso a la cámara. Ve a Ajustes → Privacidad → Cámara.'],
      NotReadableError:    ['Cámara ocupada',          'Otra aplicación está usando la cámara. Ciérrala e inténtalo de nuevo.'],
    };
    const [title, body] = msgs[err.name] || ['Sin acceso a la cámara',
      'Permite el acceso a la cámara frontal en la configuración de tu navegador.'];
    DOM.errorTitle.textContent = title;
    DOM.errorBody.textContent  = body;
    fsm.transition(STATE.ERROR);
  }

  /* ----------------------------------------------------------
     Wake Lock — evitar que la pantalla se apague
  ---------------------------------------------------------- */
  let _wakeLock = null;

  async function _requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    } catch (_) {}
  }

  function _releaseWakeLock() {
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
  }

  fsm.onChange((state) => {
    if (state === STATE.MONITORING)                         _requestWakeLock();
    if ([STATE.PAUSED, STATE.SUMMARY, STATE.IDLE,
         STATE.ERROR].includes(state))                      _releaseWakeLock();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible'
        && fsm.current === STATE.MONITORING) {
      _requestWakeLock();
    }
  });

  /* ----------------------------------------------------------
     BOTÓN: Iniciar monitoreo
  ---------------------------------------------------------- */
  DOM.btnStart?.addEventListener('click', async () => {
    alertSystem.resume(); // desbloquear AudioContext con gesto
    try {
      await cameraManager.start();
    } catch (err) {
      _handleCameraError(err);
      return;
    }
    tripTracker.start();
    fsm.transition(STATE.MONITORING);
  });

  /* ----------------------------------------------------------
     BOTÓN: Pausa — toque mínimo 200 ms
  ---------------------------------------------------------- */
  let _pressAt = 0;

  DOM.btnPause?.addEventListener('pointerdown', () => { _pressAt = Date.now(); });
  DOM.btnPause?.addEventListener('pointerleave', () => { _pressAt = 0; });

  DOM.btnPause?.addEventListener('pointerup', () => {
    if (Date.now() - _pressAt < CFG.PAUSE_MIN_PRESS_MS) return;
    _pressAt = 0;

    const s = fsm.current;
    if (s === STATE.MONITORING || s === STATE.PREALERT) {
      fsm.transition(STATE.PAUSED);
    } else if (s === STATE.PAUSED) {
      fsm.transition(STATE.MONITORING);
    }
  });

  /* ----------------------------------------------------------
     BOTÓN: Finalizar viaje
  ---------------------------------------------------------- */
  DOM.btnEndTrip?.addEventListener('click', () => {
    if (fsm.current === STATE.MONITORING) fsm.transition(STATE.SUMMARY);
  });

  /* ----------------------------------------------------------
     BOTÓN: Entendido (prealerta)
  ---------------------------------------------------------- */
  DOM.btnUnderstood?.addEventListener('click', () => {
    if (fsm.current === STATE.PREALERT) {
      eyeClosedTimer.reset();
      fsm.transition(STATE.MONITORING);
    }
  });

  /* ----------------------------------------------------------
     BOTÓN: Estoy despierto (fase reducida)
  ---------------------------------------------------------- */
  DOM.btnAwake?.addEventListener('click', () => {
    if (fsm.current === STATE.REDUCED) reducedPhase.confirm();
  });

  /* ----------------------------------------------------------
     BOTÓN: Cerrar recomendaciones → reanudar
  ---------------------------------------------------------- */
  DOM.btnRecClose?.addEventListener('click', () => {
    hideOverlay(DOM.overlayRecommendations);
    eyeClosedTimer.reset();
    fsm.transition(STATE.MONITORING);
  });

  /* ----------------------------------------------------------
     BOTÓN: Reanudar desde pantalla de pausa
  ---------------------------------------------------------- */
  DOM.btnResume?.addEventListener('click', () => {
    if (fsm.current === STATE.PAUSED) fsm.transition(STATE.MONITORING);
  });

  /* ----------------------------------------------------------
     BOTÓN: Cerrar resumen
  ---------------------------------------------------------- */
  DOM.btnSummaryClose?.addEventListener('click', () => {
    fsm.transition(STATE.IDLE);
  });

  /* ----------------------------------------------------------
     BOTÓN: Reintentar (pantalla de error)
  ---------------------------------------------------------- */
  DOM.btnRetry?.addEventListener('click', () => {
    if (fsm.current === STATE.ERROR) {
      DOM.errorTitle.textContent = '';
      DOM.errorBody.textContent  = '';
      fsm.transition(STATE.IDLE);
    }
  });

  return { onDetectionResult };
})();

/* ================================================================
   PWA INSTALL BANNER
================================================================ */
(() => {
  let _deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferred = e;
    if (DOM.installBanner) DOM.installBanner.hidden = false;
  });

  DOM.btnInstall?.addEventListener('click', async () => {
    if (!_deferred) return;
    _deferred.prompt();
    await _deferred.userChoice;
    _deferred = null;
    if (DOM.installBanner) DOM.installBanner.hidden = true;
  });

  DOM.btnDismissInstall?.addEventListener('click', () => {
    if (DOM.installBanner) DOM.installBanner.hidden = true;
  });
})();

/* ================================================================
   LOADER — splash screen + carga de modelos
================================================================ */
const loader = (() => {
  function _setProgress(pct, msg) {
    if (DOM.splashBar) DOM.splashBar.style.width = pct + '%';
    if (DOM.splashBarWrap) DOM.splashBarWrap.setAttribute('aria-valuenow', pct);
    if (msg && DOM.splashStatus) DOM.splashStatus.innerHTML = msg;
  }

  async function run() {
    showScreen('splash');
    fsm.transition(STATE.LOADING);
    try {
      await detectionEngine.init(_setProgress);
      await new Promise((r) => setTimeout(r, 400));
      fsm.transition(STATE.IDLE);
    } catch (err) {
      console.error('[Loader] Error:', err);
      DOM.errorTitle.textContent = 'Error al cargar los modelos de IA';
      DOM.errorBody.textContent  =
        'Comprueba tu conexión a internet en el primer uso y vuelve a intentarlo. '
        + 'Una vez cargados, la app funciona sin conexión.';
      fsm.transition(STATE.ERROR);
    }
  }

  return { run };
})();

/* ================================================================
   ARRANQUE
================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  loader.run();
});
