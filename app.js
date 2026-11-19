/**
 * CONTROLLER PRINCIPALE DELL'APPLICAZIONE (v10)
 * - Ritaglio ad alto contrasto (contrast 145% + grayscale) per leggere meglio cifre a penna/matita
 * - Elaborazione pagine 2..N protetta da timeout e ritardo anti-rate-limit, con aggiornamento live
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const AppState = {
  contentTypes: [],
  pdfDoc: null,
  currentBatch: null,
  pagesData: [],
  currentReviewIndex: 0,
  sessionCorrections: [],
  latestCalibratedTypeId: null,
  latestCalibratedBox: null
};

document.addEventListener('DOMContentLoaded', () => {
  const isDbConnected = ApiService.init();
  updateDbStatusBadge(isDbConnected);

  const loginHint = document.getElementById('login-db-hint');
  if (loginHint) {
    loginHint.textContent = isDbConnected
      ? 'Connesso a Supabase — Password verificata su database'
      : 'ERRORE: Configura supabaseUrl e supabaseKey dentro config.js';
  }

  setupLogin();
  setupNavigation();
  setupSettingsModal();
  setupScannerWorkflow();
  setupBackoffice();

  setupBoundingBoxDrawing(
    'cal-canvas-wrapper',
    'cal-bbox',
    (newBox) => {
      if (!AppState.pagesData[0]) {
        AppState.pagesData[0] = { page_number: 1, rotation: 0, bounding_box: newBox };
      }
      AppState.pagesData[0].bounding_box = newBox;
      AppState.latestCalibratedBox = { ...newBox };
      document.getElementById('cal-coords-display').textContent =
        `X:${newBox.x}% Y:${newBox.y}% W:${newBox.w}% H:${newBox.h}%`;
      extractCroppedImageWithPadding(document.getElementById('cal-pdf-canvas'), newBox, 5, 'cal-crop-canvas');
    },
    async (finalBox) => {
      await runTargetedOcrOnCalibrationBox(finalBox);
    }
  );

  setupBoundingBoxDrawing(
    'rev-canvas-wrapper',
    'rev-bbox',
    (newBox) => {
      const pageObj = AppState.pagesData[AppState.currentReviewIndex];
      if (pageObj) {
        pageObj.bounding_box = newBox;
        AppState.latestCalibratedBox = { ...newBox };
        extractCroppedImageWithPadding(document.getElementById('rev-pdf-canvas'), newBox, 5, 'rev-crop-canvas');
      }
    },
    async (finalBox) => {
      await runTargetedOcrOnReviewBox(finalBox);
    }
  );
});

// ============================================================================
// 1. AUTENTICAZIONE CON PASSWORD SUL DATABASE SUPABASE
// ============================================================================
function setupLogin() {
  const loginScreen = document.getElementById('login-screen');
  const appContainer = document.getElementById('app-container');
  const loginForm = document.getElementById('login-form');
  const passInput = document.getElementById('login-password');
  const errorMsg = document.getElementById('login-error');
  const submitBtn = document.getElementById('btn-login-submit');

  if (sessionStorage.getItem('docscanner_auth') === 'true') {
    loginScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    loadInitialData();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifica su database...';
    errorMsg.classList.add('hidden');

    try {
      const isValid = await ApiService.verifyAppPassword(passInput.value);
      if (isValid) {
        sessionStorage.setItem('docscanner_auth', 'true');
        loginScreen.classList.add('hidden');
        appContainer.classList.remove('hidden');
        await loadInitialData();
      } else {
        errorMsg.textContent = 'Password non corretta. Riprova.';
        errorMsg.classList.remove('hidden');
        passInput.value = '';
      }
    } catch (err) {
      errorMsg.textContent = err.message;
      errorMsg.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Accedi al Sistema';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('docscanner_auth');
    location.reload();
  });
}

async function loadInitialData() {
  AppState.contentTypes = await ApiService.getContentTypes();
  renderBackofficeTable();
  populateTypeSelects();
}

function updateDbStatusBadge(connected) {
  const badge = document.getElementById('db-status-badge');
  if (connected) {
    badge.textContent = 'Supabase + Edge AI: Connessi';
    badge.className = 'status-pill status-ok';
  } else {
    badge.textContent = 'DB: Non Configurato in config.js';
    badge.className = 'status-pill status-warn';
  }
}

// ============================================================================
// 2. NAVIGAZIONE TAB & MODALE IMPOSTAZIONI
// ============================================================================
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetId = btn.getAttribute('data-tab');
      document.querySelectorAll('.view-section').forEach(sec => {
        sec.classList.toggle('hidden', sec.id !== targetId);
      });

      if (targetId === 'history-view') loadHistoryTable();
      if (targetId === 'backoffice-view') loadInitialData();
    });
  });
}

function setupSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const fillModalFields = () => {
    document.getElementById('cfg-supabase-url').value = ApiService.config.supabaseUrl || '';
    document.getElementById('cfg-supabase-key').value = ApiService.config.supabaseKey || '';
    document.getElementById('cfg-edge-fn').value = ApiService.config.edgeFunctionName || 'analyze-doc';
    document.getElementById('cfg-app-password').value = '';
  };

  document.getElementById('btn-open-settings').addEventListener('click', () => {
    fillModalFields();
    modal.classList.remove('hidden');
  });

  document.getElementById('btn-close-settings').addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('btn-reset-config-file').addEventListener('click', async () => {
    const connected = ApiService.resetToFileConfig();
    fillModalFields();
    updateDbStatusBadge(connected);
    await loadInitialData();
    alert('Ripristinati i parametri dal file config.js.');
  });

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const connected = ApiService.saveConfig({
      supabaseUrl: document.getElementById('cfg-supabase-url').value.trim(),
      supabaseKey: document.getElementById('cfg-supabase-key').value.trim(),
      edgeFunctionName: document.getElementById('cfg-edge-fn').value.trim() || 'analyze-doc'
    });

    const newPass = document.getElementById('cfg-app-password').value.trim();
    if (newPass) {
      try {
        await ApiService.updateAppPassword(newPass);
        alert('Password aggiornata con successo nel database!');
      } catch (err) {
        alert('Errore aggiornamento password sul database: ' + err.message);
      }
    }

    updateDbStatusBadge(connected);
    await loadInitialData();
    modal.classList.add('hidden');
  });
}

// ============================================================================
// 3. WORKFLOW SCANNER + OCR AD ALTO CONTRASTO + RICERCA SPAZIALE ADATTIVA
// ============================================================================
function setScannerStep(stepNumber) {
  const panels = ['step-upload', 'step-calibrate', 'step-processing', 'step-decision', 'step-review', 'step-output'];
  panels.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (stepNumber === 1) document.getElementById('step-upload').classList.remove('hidden');
  if (stepNumber === 2) document.getElementById('step-calibrate').classList.remove('hidden');
  if (stepNumber === 3) document.getElementById('step-processing').classList.remove('hidden');
  if (stepNumber === 4) document.getElementById('step-decision').classList.remove('hidden');
  if (stepNumber === '5B') document.getElementById('step-review').classList.remove('hidden');
  if (stepNumber === '5A') document.getElementById('step-output').classList.remove('hidden');

  const numericStep = typeof stepNumber === 'string' ? 5 : stepNumber;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`ind-step-${i}`);
    el.classList.remove('active', 'done');
    if (i < numericStep) el.classList.add('done');
    if (i === numericStep) el.classList.add('active');
  }
}

function showOcrErrorBanner(containerId, errorMsg) {
  const banner = document.getElementById(containerId);
  if (!banner) return;
  if (errorMsg) {
    banner.textContent = `⚠️ Errore Edge Function OCR: ${errorMsg}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function setupScannerWorkflow() {
  const fileInput = document.getElementById('pdf-file-input');
  const dropzone = document.getElementById('dropzone');

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handlePdfFileSelected(e.target.files[0]);
  });

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#0f4c81'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#94a3b8'; });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#94a3b8';
    if (e.dataTransfer.files[0]) handlePdfFileSelected(e.dataTransfer.files[0]);
  });

  document.getElementById('btn-cal-rot-ccw').addEventListener('click', () => rotateCalibrationPage(-90));
  document.getElementById('btn-cal-rot-180').addEventListener('click', () => rotateCalibrationPage(180));
  document.getElementById('btn-cal-rot-cw').addEventListener('click', () => rotateCalibrationPage(90));
  document.getElementById('btn-cal-reanalyze').addEventListener('click', () => {
    if (AppState.pagesData[0]) runTargetedOcrOnCalibrationBox(AppState.pagesData[0].bounding_box);
  });

  document.getElementById('btn-rev-rot-ccw').addEventListener('click', () => rotateReviewPage(-90));
  document.getElementById('btn-rev-rot-180').addEventListener('click', () => rotateReviewPage(180));
  document.getElementById('btn-rev-rot-cw').addEventListener('click', () => rotateReviewPage(90));
  document.getElementById('btn-rev-reanalyze').addEventListener('click', () => {
    const p = AppState.pagesData[AppState.currentReviewIndex];
    if (p) runTargetedOcrOnReviewBox(p.bounding_box);
  });

  document.getElementById('cal-type-select').addEventListener('change', async (e) => {
    const selectedType = AppState.contentTypes.find(t => t.id === e.target.value);
    if (selectedType) {
      AppState.latestCalibratedTypeId = selectedType.id;
      document.getElementById('cal-unit-label').textContent = selectedType.unit ? `(${selectedType.unit})` : '';
      document.getElementById('cal-bbox-label').textContent = selectedType.target_field_label;
      updateLearnedBadge('cal-learned-count-badge', selectedType);
      if (selectedType.expected_box && AppState.pagesData[0]) {
        AppState.pagesData[0].bounding_box = { ...selectedType.expected_box };
        AppState.latestCalibratedBox = { ...selectedType.expected_box };
        applyBoundingBox('cal-bbox', selectedType.expected_box);
        extractCroppedImageWithPadding(document.getElementById('cal-pdf-canvas'), selectedType.expected_box, 5, 'cal-crop-canvas');
        await runTargetedOcrOnCalibrationBox(selectedType.expected_box);
      }
    }
  });

  document.getElementById('btn-cancel-scan').addEventListener('click', resetScanner);
  document.getElementById('btn-new-scan').addEventListener('click', resetScanner);
  document.getElementById('btn-confirm-page1').addEventListener('click', processRemainingPages);

  document.getElementById('btn-decision-yes').addEventListener('click', async () => {
    await ApiService.updateBatch(AppState.currentBatch.id, {
      status: 'completed',
      completed_at: new Date().toISOString()
    });
    renderFinalOutput();
    setScannerStep('5A');
  });

  document.getElementById('btn-decision-no').addEventListener('click', () => {
    ApiService.updateBatch(AppState.currentBatch.id, { status: 'in_review' });
    AppState.currentReviewIndex = 0;
    setScannerStep('5B');
    loadReviewPage(0);
  });

  document.getElementById('btn-rev-prev').addEventListener('click', () => navigateReview(-1));
  document.getElementById('btn-rev-next').addEventListener('click', () => navigateReview(1));

  document.getElementById('btn-rev-accept-page').addEventListener('click', async () => {
    await saveAndLearnCurrentReviewPage(true);
    if (AppState.currentReviewIndex < AppState.pagesData.length - 1) {
      navigateReview(1, true);
    } else {
      finishReviewAndShowOutput();
    }
  });

  document.getElementById('btn-rev-reapply-remaining').addEventListener('click', reapplyLearnedRulesToRemainingPages);

  document.getElementById('btn-rev-finish-all').addEventListener('click', async () => {
    await saveAndLearnCurrentReviewPage(true);
    finishReviewAndShowOutput();
  });

  document.getElementById('btn-export-csv').addEventListener('click', exportReportCsv);
}

async function runTargetedOcrOnCalibrationBox(box) {
  if (!AppState.pagesData[0] || !box) return;
  const liveBadge = document.getElementById('cal-ocr-live-badge');
  liveBadge.textContent = 'Lettura Gemini OCR...';
  liveBadge.classList.remove('hidden');

  const fullCanvas = document.getElementById('cal-pdf-canvas');
  const fullBase64 = canvasToOptimizedDataUrl(fullCanvas, 1100, 0.80, false);
  const croppedBase64 = extractCroppedImageWithPadding(fullCanvas, box, 5, 'cal-crop-canvas');

  const selectedTypeId = document.getElementById('cal-type-select').value;
  const res = await ApiService.analyzePageImage(
    fullBase64,
    1,
    AppState.contentTypes,
    {
      primaryTypeId: selectedTypeId,
      referenceBox: box,
      sessionCorrections: AppState.sessionCorrections
    },
    box,
    croppedBase64
  );

  showOcrErrorBanner('cal-ocr-error-banner', res.errorMsg);

  AppState.pagesData[0].detected_value = res.detected_value;
  AppState.pagesData[0].raw_text_read = res.raw_text_read;
  AppState.pagesData[0].confidence = res.confidence;
  AppState.pagesData[0].bounding_box = { ...box };
  AppState.latestCalibratedBox = { ...box };

  const matchedType = AppState.contentTypes.find(t => t.id === selectedTypeId);
  document.getElementById('cal-value-input').value = res.detected_value !== 0 ? res.detected_value : '';
  document.getElementById('cal-confidence').textContent = `${Math.round(res.confidence * 100)}% (Testo letto: "${res.raw_text_read || 'nessuno'}")`;
  document.getElementById('cal-bbox-label').textContent = `${matchedType?.target_field_label || 'Valore'}: ${res.detected_value}`;

  liveBadge.textContent = res.errorMsg ? '⚠ Errore OCR' : '✓ Letto';
  setTimeout(() => liveBadge.classList.add('hidden'), 1800);
}

async function runTargetedOcrOnReviewBox(box) {
  const pageObj = AppState.pagesData[AppState.currentReviewIndex];
  if (!pageObj || !box) return;

  const liveBadge = document.getElementById('rev-ocr-live-badge');
  liveBadge.textContent = 'Lettura Gemini OCR...';
  liveBadge.classList.remove('hidden');

  const fullCanvas = document.getElementById('rev-pdf-canvas');
  const fullBase64 = canvasToOptimizedDataUrl(fullCanvas, 1100, 0.80, false);
  const croppedBase64 = extractCroppedImageWithPadding(fullCanvas, box, 5, 'rev-crop-canvas');

  const selectedTypeId = document.getElementById('rev-type-select').value;
  const res = await ApiService.analyzePageImage(
    fullBase64,
    pageObj.page_number,
    AppState.contentTypes,
    {
      primaryTypeId: selectedTypeId,
      referenceBox: box,
      sessionCorrections: AppState.sessionCorrections
    },
    box,
    croppedBase64
  );

  showOcrErrorBanner('rev-ocr-error-banner', res.errorMsg);

  pageObj.detected_value = res.detected_value;
  pageObj.raw_text_read = res.raw_text_read;
  pageObj.confidence = res.confidence;
  pageObj.bounding_box = { ...box };
  pageObj.box_moved_by_user = true;
  AppState.latestCalibratedBox = { ...box };

  const matchedType = AppState.contentTypes.find(t => t.id === selectedTypeId);
  document.getElementById('rev-value-input').value = res.detected_value;
  document.getElementById('rev-confidence').textContent = `${Math.round(res.confidence * 100)}% (Testo letto: "${res.raw_text_read || 'nessuno'}")`;
  document.getElementById('rev-bbox-label').textContent = `${matchedType?.code || 'Valore'}: ${res.detected_value}`;
  updateRunningSumDisplay();

  liveBadge.textContent = res.errorMsg ? '⚠ Errore OCR' : '✓ Letto';
  setTimeout(() => liveBadge.classList.add('hidden'), 1800);
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function formatRotationLabel(deg) {
  if (deg === 0) return '0° (Normale)';
  if (deg === 90) return '90° Orario';
  if (deg === 180) return '180° Capovolta';
  if (deg === 270) return '270° (90° Antiorario)';
  return `${deg}°`;
}

async function rotateCalibrationPage(deltaDegrees) {
  if (!AppState.pdfDoc) return;
  if (!AppState.pagesData[0]) {
    AppState.pagesData[0] = {
      page_number: 1,
      rotation: 0,
      bounding_box: { x: 60, y: 70, w: 20, h: 7 }
    };
  }
  const newRot = normalizeAngle((AppState.pagesData[0].rotation || 0) + deltaDegrees);
  AppState.pagesData[0].rotation = newRot;

  document.getElementById('cal-rot-badge').textContent = `${newRot}°`;
  document.getElementById('cal-rot-meta').textContent = formatRotationLabel(newRot);

  await renderPdfPageToCanvas(1, 'cal-pdf-canvas', newRot);
  extractCroppedImageWithPadding(document.getElementById('cal-pdf-canvas'), AppState.pagesData[0].bounding_box, 5, 'cal-crop-canvas');
  await runTargetedOcrOnCalibrationBox(AppState.pagesData[0].bounding_box);
}

async function rotateReviewPage(deltaDegrees) {
  const pageObj = AppState.pagesData[AppState.currentReviewIndex];
  if (!pageObj || !AppState.pdfDoc) return;
  const newRot = normalizeAngle((pageObj.rotation || 0) + deltaDegrees);
  pageObj.rotation = newRot;

  document.getElementById('rev-rot-badge').textContent = `${newRot}°`;
  document.getElementById('rev-rot-meta').textContent = formatRotationLabel(newRot);

  await renderPdfPageToCanvas(pageObj.page_number, 'rev-pdf-canvas', newRot);
  extractCroppedImageWithPadding(document.getElementById('rev-pdf-canvas'), pageObj.bounding_box, 5, 'rev-crop-canvas');
  await runTargetedOcrOnReviewBox(pageObj.bounding_box);
}

async function handlePdfFileSelected(file) {
  if (AppState.contentTypes.length === 0) {
    alert('Configura almeno una Tipologia di Contenuto nel Backoffice prima di scansionare un PDF.');
    return;
  }

  AppState.sessionCorrections = [];
  const arrayBuffer = await file.arrayBuffer();
  AppState.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = AppState.pdfDoc.numPages;

  AppState.currentBatch = await ApiService.createBatch(file.name, totalPages);
  AppState.pagesData = new Array(totalPages);

  const defaultType = AppState.contentTypes[0];
  const initialBox = defaultType?.expected_box || { x: 60, y: 70, w: 20, h: 7 };

  AppState.pagesData[0] = {
    page_number: 1,
    detected_type_id: defaultType?.id || null,
    ai_initial_value: 0,
    detected_value: 0,
    raw_text_read: '',
    bounding_box: { ...initialBox },
    rotation: 0,
    confidence: 0,
    is_verified: false,
    notes: ''
  };
  AppState.latestCalibratedTypeId = defaultType?.id || null;
  AppState.latestCalibratedBox = { ...initialBox };

  populateTypeSelects();
  document.getElementById('cal-total-pages').textContent = totalPages;
  document.getElementById('cal-rot-badge').textContent = '0°';
  document.getElementById('cal-rot-meta').textContent = formatRotationLabel(0);
  document.getElementById('cal-coords-display').textContent =
    `X:${initialBox.x}% Y:${initialBox.y}% W:${initialBox.w}% H:${initialBox.h}%`;
  applyBoundingBox('cal-bbox', initialBox);

  setScannerStep(2);

  const base64Page1 = await renderPdfPageToCanvas(1, 'cal-pdf-canvas', 0);
  extractCroppedImageWithPadding(document.getElementById('cal-pdf-canvas'), initialBox, 5, 'cal-crop-canvas');

  const liveBadge = document.getElementById('cal-ocr-live-badge');
  liveBadge.textContent = 'Analisi iniziale Gemini...';
  liveBadge.classList.remove('hidden');

  const analysis = await ApiService.analyzePageImage(base64Page1, 1, AppState.contentTypes, null);

  liveBadge.classList.add('hidden');
  showOcrErrorBanner('cal-ocr-error-banner', analysis.errorMsg);

  const userRot = AppState.pagesData[0].rotation || 0;
  AppState.pagesData[0] = {
    ...AppState.pagesData[0],
    detected_type_id: analysis.detected_type_id || defaultType?.id,
    ai_initial_value: analysis.detected_value,
    detected_value: analysis.detected_value,
    raw_text_read: analysis.raw_text_read,
    bounding_box: { ...analysis.bounding_box },
    rotation: userRot,
    confidence: analysis.confidence
  };

  AppState.latestCalibratedTypeId = AppState.pagesData[0].detected_type_id;
  AppState.latestCalibratedBox = { ...analysis.bounding_box };

  const typeSelect = document.getElementById('cal-type-select');
  typeSelect.value = AppState.pagesData[0].detected_type_id;

  const matchedType = AppState.contentTypes.find(t => t.id === AppState.pagesData[0].detected_type_id);
  updateLearnedBadge('cal-learned-count-badge', matchedType);
  document.getElementById('cal-unit-label').textContent = matchedType?.unit ? `(${matchedType.unit})` : '';
  document.getElementById('cal-bbox-label').textContent = `${matchedType?.target_field_label || 'Valore'}: ${analysis.detected_value}`;
  document.getElementById('cal-value-input').value = analysis.detected_value !== 0 ? analysis.detected_value : '';
  document.getElementById('cal-confidence').textContent = `${Math.round(analysis.confidence * 100)}% (Testo letto: "${analysis.raw_text_read || 'nessuno'}")`;
  document.getElementById('cal-coords-display').textContent =
    `X:${analysis.bounding_box.x}% Y:${analysis.bounding_box.y}% W:${analysis.bounding_box.w}% H:${analysis.bounding_box.h}%`;

  applyBoundingBox('cal-bbox', analysis.bounding_box);
  extractCroppedImageWithPadding(document.getElementById('cal-pdf-canvas'), analysis.bounding_box, 5, 'cal-crop-canvas');
}

async function processRemainingPages() {
  const confirmedTypeId = document.getElementById('cal-type-select').value;
  const confirmedValue = parseFloat(document.getElementById('cal-value-input').value) || 0;
  const confirmedBox = { ...AppState.pagesData[0].bounding_box };
  const inheritedRotation = AppState.pagesData[0].rotation || 0;

  AppState.pagesData[0].detected_type_id = confirmedTypeId;
  AppState.pagesData[0].detected_value = confirmedValue;
  AppState.pagesData[0].is_verified = true;
  AppState.latestCalibratedTypeId = confirmedTypeId;
  AppState.latestCalibratedBox = { ...confirmedBox };

  const correctionRecord = {
    page: 1,
    type_id: confirmedTypeId,
    ai_initial_value: AppState.pagesData[0].ai_initial_value,
    confirmed_value: confirmedValue,
    box: confirmedBox,
    note: 'Calibrazione manuale Pagina 1'
  };
  AppState.sessionCorrections.push(correctionRecord);

  const typeObj = AppState.contentTypes.find(t => t.id === confirmedTypeId);
  if (typeObj) {
    await ApiService.recordHumanCorrection(typeObj, correctionRecord);
  }

  await ApiService.updateBatch(AppState.currentBatch.id, {
    status: 'processing',
    primary_type_id: confirmedTypeId
  });

  setScannerStep(3);

  const total = AppState.pdfDoc.numPages;
  const progressBar = document.getElementById('proc-progress-bar');
  const statusText = document.getElementById('proc-status-text');
  const offscreenCanvas = document.createElement('canvas');

  for (let p = 2; p <= total; p++) {
    const pct = Math.round(((p - 1) / total) * 100);
    progressBar.style.width = `${pct}%`;
    statusText.textContent = `Analisi Pagina ${p} di ${total} nell'area calibrata (X:${confirmedBox.x}%, Y:${confirmedBox.y}%)...`;

    // Piccola pausa di 350ms tra le pagine per non saturare la banda o il rate-limit API
    await new Promise(r => setTimeout(r, 350));

    const base64Img = await renderPdfPageToElement(p, offscreenCanvas, inheritedRotation);
    const searchWindowMeta = expandBoxWithMargin(confirmedBox, 12);
    const searchCropBase64 = extractCroppedImageWithPadding(offscreenCanvas, confirmedBox, 12, null);

    const res = await ApiService.analyzePageImage(
      base64Img,
      p,
      AppState.contentTypes,
      {
        primaryTypeId: confirmedTypeId,
        referenceBox: confirmedBox,
        sessionCorrections: AppState.sessionCorrections
      },
      null,
      searchCropBase64,
      searchWindowMeta
    );

    AppState.pagesData[p - 1] = {
      page_number: p,
      detected_type_id: res.detected_type_id,
      ai_initial_value: res.detected_value,
      detected_value: res.detected_value,
      raw_text_read: res.raw_text_read,
      bounding_box: res.bounding_box,
      rotation: inheritedRotation,
      confidence: res.confidence,
      is_verified: false,
      notes: res.errorMsg ? `Errore OCR: ${res.errorMsg}` : ''
    };
  }

  progressBar.style.width = '100%';
  statusText.textContent = 'Salvataggio risultati sul database...';
  await ApiService.savePagesBulk(AppState.currentBatch.id, AppState.pagesData);
  await ApiService.updateBatch(AppState.currentBatch.id, { status: 'pending_approval' });

  renderDecisionSummary();
  setScannerStep(4);
}

function renderDecisionSummary() {
  document.getElementById('dec-total-pages').textContent = AppState.pagesData.length;
  document.getElementById('dec-filename').textContent = AppState.currentBatch.filename;

  const groups = calculateTotalsByType();
  const tbody = document.getElementById('dec-summary-tbody');
  tbody.innerHTML = '';

  groups.forEach(g => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${g.code}</code></td>
      <td><strong>${g.name}</strong> <small style="color:#64748b">(${g.target_field_label})</small></td>
      <td class="text-center">${g.count}</td>
      <td class="text-right"><strong style="font-size:1.1rem;color:#0f4c81">${g.sum.toFixed(2)} ${g.unit}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  const lowConfPages = AppState.pagesData.filter(p => !p.is_verified && p.confidence < 0.85).length;
  const alertBox = document.getElementById('dec-low-conf-alert');
  if (lowConfPages > 0) {
    document.getElementById('dec-low-conf-count').textContent = lowConfPages;
    alertBox.classList.remove('hidden');
  } else {
    alertBox.classList.add('hidden');
  }
}

async function loadReviewPage(index) {
  if (index < 0 || index >= AppState.pagesData.length) return;
  AppState.currentReviewIndex = index;
  const pageData = AppState.pagesData[index];
  const rot = pageData.rotation || 0;

  document.getElementById('rev-curr-page').textContent = pageData.page_number;
  document.getElementById('rev-total-pages').textContent = AppState.pagesData.length;
  document.getElementById('rev-inspector-page').textContent = pageData.page_number;
  document.getElementById('rev-rot-badge').textContent = `${rot}°`;
  document.getElementById('rev-rot-meta').textContent = formatRotationLabel(rot);
  document.getElementById('rev-session-learn-badge').textContent = `${AppState.sessionCorrections.length} correzioni apprese`;

  await renderPdfPageToCanvas(pageData.page_number, 'rev-pdf-canvas', rot);

  const typeSelect = document.getElementById('rev-type-select');
  typeSelect.value = pageData.detected_type_id;

  const matchedType = AppState.contentTypes.find(t => t.id === pageData.detected_type_id);
  document.getElementById('rev-unit-label').textContent = matchedType?.unit ? `(${matchedType.unit})` : '';
  document.getElementById('rev-value-input').value = pageData.detected_value;
  document.getElementById('rev-notes-input').value = pageData.notes || '';
  document.getElementById('rev-confidence').textContent = `${Math.round(pageData.confidence * 100)}% (Testo letto: "${pageData.raw_text_read || 'nessuno'}")`;

  const badge = document.getElementById('rev-status-badge');
  if (pageData.is_verified) {
    badge.textContent = '✓ Pagina Verificata';
    badge.className = 'status-pill status-ok';
  } else {
    badge.textContent = `Da verificare (Confidenza ${Math.round(pageData.confidence * 100)}%)`;
    badge.className = 'status-pill status-warn';
  }

  document.getElementById('rev-bbox-label').textContent = `${matchedType?.code || 'Valore'}: ${pageData.detected_value}`;
  applyBoundingBox('rev-bbox', pageData.bounding_box);
  extractCroppedImageWithPadding(document.getElementById('rev-pdf-canvas'), pageData.bounding_box, 5, 'rev-crop-canvas');
  updateRunningSumDisplay();
}

async function saveAndLearnCurrentReviewPage(markVerified = true) {
  const pageData = AppState.pagesData[AppState.currentReviewIndex];
  if (!pageData) return;

  const newTypeId = document.getElementById('rev-type-select').value;
  const newVal = parseFloat(document.getElementById('rev-value-input').value) || 0;
  const newNotes = document.getElementById('rev-notes-input').value.trim();

  const wasModified = (newVal !== pageData.ai_initial_value) || pageData.box_moved_by_user || (newTypeId !== pageData.detected_type_id);

  pageData.detected_type_id = newTypeId;
  pageData.detected_value = newVal;
  pageData.notes = newNotes;
  if (markVerified) pageData.is_verified = true;

  if (wasModified && markVerified) {
    AppState.latestCalibratedTypeId = newTypeId;
    AppState.latestCalibratedBox = { ...pageData.bounding_box };

    const correctionRecord = {
      page: pageData.page_number,
      type_id: newTypeId,
      ai_initial_value: pageData.ai_initial_value,
      confirmed_value: newVal,
      box: { ...pageData.bounding_box },
      note: newNotes || `Correzione Pagina ${pageData.page_number}`
    };
    AppState.sessionCorrections.push(correctionRecord);

    const typeObj = AppState.contentTypes.find(t => t.id === newTypeId);
    if (typeObj) {
      await ApiService.recordHumanCorrection(typeObj, correctionRecord);
    }

    const remainingUnverified = AppState.pagesData.slice(AppState.currentReviewIndex + 1).filter(p => !p.is_verified);
    if (remainingUnverified.length > 0) {
      const reapplyBtn = document.getElementById('btn-rev-reapply-remaining');
      reapplyBtn.textContent = `🧠 Rianalizza le ${remainingUnverified.length} Pagine Successive con la Nuova Posizione/Regola`;
      reapplyBtn.classList.remove('hidden');
    }
  }

  updateRunningSumDisplay();
}

async function reapplyLearnedRulesToRemainingPages() {
  const btn = document.getElementById('btn-rev-reapply-remaining');
  btn.disabled = true;
  const offscreenCanvas = document.createElement('canvas');

  const targetTypeId = AppState.latestCalibratedTypeId || AppState.pagesData[AppState.currentReviewIndex].detected_type_id;
  const targetBox = AppState.latestCalibratedBox || AppState.pagesData[AppState.currentReviewIndex].bounding_box;

  for (let i = AppState.currentReviewIndex + 1; i < AppState.pagesData.length; i++) {
    const p = AppState.pagesData[i];
    if (p.is_verified) continue;

    btn.textContent = `⏳ Ricalibrazione Gemini Pagina ${p.page_number} di ${AppState.pagesData.length}...`;
    await new Promise(r => setTimeout(r, 350));

    const base64Img = await renderPdfPageToElement(p.page_number, offscreenCanvas, p.rotation || 0);
    const searchWindowMeta = expandBoxWithMargin(targetBox, 12);
    const searchCropBase64 = extractCroppedImageWithPadding(offscreenCanvas, targetBox, 12, null);

    const res = await ApiService.analyzePageImage(
      base64Img,
      p.page_number,
      AppState.contentTypes,
      {
        primaryTypeId: targetTypeId,
        referenceBox: targetBox,
        sessionCorrections: AppState.sessionCorrections
      },
      null,
      searchCropBase64,
      searchWindowMeta
    );

    p.detected_type_id = res.detected_type_id;
    p.ai_initial_value = res.detected_value;
    p.detected_value = res.detected_value;
    p.raw_text_read = res.raw_text_read;
    p.bounding_box = res.bounding_box;
    p.confidence = res.confidence;
  }

  btn.disabled = false;
  btn.classList.add('hidden');
  updateRunningSumDisplay();
  alert('Pagine successive rianalizzate con successo nella nuova posizione calibrata!');
  if (AppState.currentReviewIndex < AppState.pagesData.length - 1) {
    loadReviewPage(AppState.currentReviewIndex + 1);
  }
}

function navigateReview(direction, skipSave = false) {
  if (!skipSave) {
    saveAndLearnCurrentReviewPage(false);
  }
  const onlyUnverified = document.getElementById('chk-only-unverified').checked;
  let nextIdx = AppState.currentReviewIndex + direction;

  while (onlyUnverified && nextIdx >= 0 && nextIdx < AppState.pagesData.length) {
    const p = AppState.pagesData[nextIdx];
    if (!p.is_verified || p.confidence < 0.85) break;
    nextIdx += direction;
  }

  if (nextIdx >= 0 && nextIdx < AppState.pagesData.length) {
    loadReviewPage(nextIdx);
  }
}

function updateRunningSumDisplay() {
  const total = AppState.pagesData.reduce((acc, p) => acc + (Number(p.detected_value) || 0), 0);
  document.getElementById('rev-running-sum').textContent = total.toFixed(2);
}

async function finishReviewAndShowOutput() {
  await ApiService.savePagesBulk(AppState.currentBatch.id, AppState.pagesData);
  await ApiService.updateBatch(AppState.currentBatch.id, {
    status: 'completed',
    completed_at: new Date().toISOString()
  });
  renderFinalOutput();
  setScannerStep('5A');
}

function renderFinalOutput() {
  document.getElementById('out-filename').textContent = AppState.currentBatch.filename;
  document.getElementById('out-total-pages').textContent = AppState.pagesData.length;

  const groups = calculateTotalsByType();
  const totalsTbody = document.getElementById('out-totals-tbody');
  totalsTbody.innerHTML = '';

  groups.forEach(g => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${g.code}</code></td>
      <td><strong>${g.name}</strong></td>
      <td>${g.target_field_label}</td>
      <td class="text-center">${g.count}</td>
      <td class="text-right"><strong style="font-size:1.2rem;color:#2b9348">${g.sum.toFixed(2)} ${g.unit}</strong></td>
    `;
    totalsTbody.appendChild(tr);
  });

  const pagesTbody = document.getElementById('out-pages-tbody');
  pagesTbody.innerHTML = '';
  AppState.pagesData.forEach(p => {
    const t = AppState.contentTypes.find(ct => ct.id === p.detected_type_id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>#${p.page_number}</strong></td>
      <td>${t ? `${t.code} — ${t.name}` : 'Non assegnato'}</td>
      <td class="text-center"><code>${p.rotation || 0}°</code></td>
      <td class="text-right"><strong>${Number(p.detected_value).toFixed(2)} ${t?.unit || ''}</strong></td>
      <td class="text-center">
        <span class="status-pill ${p.is_verified ? 'status-ok' : 'status-warn'}">
          ${p.is_verified ? 'Verificato' : 'Auto (' + Math.round(p.confidence * 100) + '%)'}
        </span>
      </td>
      <td>${p.notes || '-'}</td>
    `;
    pagesTbody.appendChild(tr);
  });
}

function calculateTotalsByType() {
  const map = {};
  AppState.pagesData.forEach(p => {
    const t = AppState.contentTypes.find(ct => ct.id === p.detected_type_id) || {
      id: 'unknown', code: 'N/D', name: 'Tipologia Sconosciuta', target_field_label: '-', unit: ''
    };
    if (!map[t.id]) {
      map[t.id] = { ...t, count: 0, sum: 0 };
    }
    map[t.id].count += 1;
    map[t.id].sum += Number(p.detected_value) || 0;
  });
  return Object.values(map);
}

function exportReportCsv() {
  let csv = 'Pagina;Codice Tipologia;Nome Tipologia;Rotazione Gradi;Valore;Unita;Verificato;Note\n';
  AppState.pagesData.forEach(p => {
    const t = AppState.contentTypes.find(ct => ct.id === p.detected_type_id);
    csv += `${p.page_number};"${t?.code || ''}";"${t?.name || ''}";${p.rotation || 0};${Number(p.detected_value).toFixed(2)};"${t?.unit || ''}";${p.is_verified ? 'SI' : 'NO'};"${p.notes || ''}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Report_${AppState.currentBatch.filename.replace('.pdf', '')}.csv`;
  a.click();
}

function resetScanner() {
  document.getElementById('pdf-file-input').value = '';
  AppState.pdfDoc = null;
  AppState.pagesData = [];
  AppState.sessionCorrections = [];
  setScannerStep(1);
}

// ============================================================================
// 4. UTILITY PDF.JS, CONTRASTO OCR & BOUNDING BOX
// ============================================================================
function canvasToOptimizedDataUrl(srcCanvas, maxDim = 1100, quality = 0.80, enhanceContrast = false) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const scale = Math.max(w, h) > maxDim ? (maxDim / Math.max(w, h)) : 1;
  const temp = document.createElement('canvas');
  temp.width = Math.round(w * scale);
  temp.height = Math.round(h * scale);
  const ctx = temp.getContext('2d');

  // Sfondo bianco opaco (evita trasparenze PDF che diventano nere in JPEG!)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, temp.width, temp.height);

  if (enhanceContrast) {
    ctx.filter = 'grayscale(100%) contrast(150%) brightness(105%)';
  }
  ctx.drawImage(srcCanvas, 0, 0, temp.width, temp.height);
  return temp.toDataURL('image/jpeg', quality);
}

async function renderPdfPageToCanvas(pageNum, canvasId, extraRotation = 0) {
  const canvas = document.getElementById(canvasId);
  return await renderPdfPageToElement(pageNum, canvas, extraRotation);
}

async function renderPdfPageToElement(pageNum, canvasEl, extraRotation = 0) {
  const page = await AppState.pdfDoc.getPage(pageNum);
  const nativeRotation = page.rotate || 0;
  const totalRotation = normalizeAngle(nativeRotation + extraRotation);

  const viewport = page.getViewport({ scale: 1.8, rotation: totalRotation });
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = viewport.width;
  canvasEl.height = viewport.height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvasToOptimizedDataUrl(canvasEl, 1100, 0.80, false);
}

function expandBoxWithMargin(box, marginPct = 10) {
  const x = Math.max(0, box.x - marginPct);
  const y = Math.max(0, box.y - marginPct);
  const right = Math.min(100, box.x + box.w + marginPct);
  const bottom = Math.min(100, box.y + box.h + marginPct);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(5, Math.round(right - x)),
    h: Math.max(4, Math.round(bottom - y))
  };
}

function extractCroppedImageWithPadding(srcCanvas, box, paddingPct = 5, previewCanvasId = null) {
  if (!srcCanvas || !box || srcCanvas.width === 0) return null;

  const expanded = expandBoxWithMargin(box, paddingPct);
  const sx = Math.max(0, Math.floor((expanded.x / 100) * srcCanvas.width));
  const sy = Math.max(0, Math.floor((expanded.y / 100) * srcCanvas.height));
  const sw = Math.max(20, Math.floor((expanded.w / 100) * srcCanvas.width));
  const sh = Math.max(20, Math.floor((expanded.h / 100) * srcCanvas.height));

  const tempCanvas = previewCanvasId ? document.getElementById(previewCanvasId) : document.createElement('canvas');
  if (!tempCanvas) return null;

  tempCanvas.width = sw;
  tempCanvas.height = sh;
  const ctx = tempCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Invia all'OCR il ritaglio con contrasto potenziato per far risaltare l'inchiostro a mano
  return canvasToOptimizedDataUrl(tempCanvas, 800, 0.90, true);
}

function applyBoundingBox(bboxElementId, box) {
  const el = document.getElementById(bboxElementId);
  if (!el || !box) return;
  el.style.left = `${box.x}%`;
  el.style.top = `${box.y}%`;
  el.style.width = `${box.w}%`;
  el.style.height = `${box.h}%`;
}

function setupBoundingBoxDrawing(wrapperId, bboxId, onBoxDragging, onBoxReleased) {
  const wrapper = document.getElementById(wrapperId);
  let isDrawing = false;
  let hasDragged = false;
  let startX = 0, startY = 0;
  let latestBox = null;

  wrapper.addEventListener('mousedown', (e) => {
    const rect = wrapper.getBoundingClientRect();
    isDrawing = true;
    hasDragged = false;
    startX = ((e.clientX - rect.left) / rect.width) * 100;
    startY = ((e.clientY - rect.top) / rect.height) * 100;
  });

  wrapper.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const rect = wrapper.getBoundingClientRect();
    const currX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const currY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

    if (Math.abs(currX - startX) > 1 || Math.abs(currY - startY) > 1) {
      hasDragged = true;
    }

    latestBox = {
      x: Math.round(Math.min(startX, currX)),
      y: Math.round(Math.min(startY, currY)),
      w: Math.max(3, Math.round(Math.abs(currX - startX))),
      h: Math.max(2, Math.round(Math.abs(currY - startY)))
    };
    applyBoundingBox(bboxId, latestBox);
    if (onBoxDragging) onBoxDragging(latestBox);
  });

  window.addEventListener('mouseup', async () => {
    if (isDrawing && hasDragged && latestBox) {
      isDrawing = false;
      hasDragged = false;
      if (onBoxReleased) await onBoxReleased(latestBox);
    } else {
      isDrawing = false;
      hasDragged = false;
    }
  });
}

function updateLearnedBadge(badgeId, typeObj) {
  const el = document.getElementById(badgeId);
  if (!el) return;
  const count = Array.isArray(typeObj?.learned_examples) ? typeObj.learned_examples.length : 0;
  el.textContent = `${count} esempi appresi nel DB`;
}

// ============================================================================
// 5. BACKOFFICE TIPOLOGIE (CRUD) & STORICO
// ============================================================================
function populateTypeSelects() {
  const selects = [document.getElementById('cal-type-select'), document.getElementById('rev-type-select')];
  selects.forEach(sel => {
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '';
    AppState.contentTypes.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.code} — ${t.name} (${t.target_field_label})`;
      sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal;
  });
}

function setupBackoffice() {
  const form = document.getElementById('bo-type-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      id: document.getElementById('bo-type-id').value || null,
      code: document.getElementById('bo-code').value.trim().toUpperCase(),
      name: document.getElementById('bo-name').value.trim(),
      target_field_label: document.getElementById('bo-field-label').value.trim(),
      unit: document.getElementById('bo-unit').value.trim(),
      ai_hints: document.getElementById('bo-hints').value.trim()
    };

    try {
      await ApiService.saveContentType(payload);
      resetBackofficeForm();
      await loadInitialData();
    } catch (err) {
      alert('Errore salvataggio tipologia: ' + err.message);
    }
  });

  document.getElementById('btn-bo-reset').addEventListener('click', resetBackofficeForm);
  document.getElementById('btn-bo-refresh').addEventListener('click', loadInitialData);
  document.getElementById('btn-hist-refresh').addEventListener('click', loadHistoryTable);
}

function renderBackofficeTable() {
  const tbody = document.getElementById('bo-types-tbody');
  tbody.innerHTML = '';

  AppState.contentTypes.forEach(t => {
    const learnedCount = Array.isArray(t.learned_examples) ? t.learned_examples.length : 0;
    const boxStr = t.expected_box ? `X:${t.expected_box.x}% Y:${t.expected_box.y}%` : 'Auto';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${t.code}</code></td>
      <td><strong>${t.name}</strong><br><small style="color:#64748b">${t.ai_hints || ''}</small></td>
      <td>${t.target_field_label} ${t.unit ? `(${t.unit})` : ''}</td>
      <td>
        <span class="learned-badge">${learnedCount} correzioni apprese</span><br>
        <small style="color:#64748b">Area attesa: <code>${boxStr}</code></small>
      </td>
      <td class="text-right">
        <button class="btn btn-outline btn-sm" onclick="editContentType('${t.id}')">Modifica</button>
        <button class="btn btn-danger-outline btn-sm" onclick="removeContentType('${t.id}')">Elimina</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.editContentType = function(id) {
  const t = AppState.contentTypes.find(item => item.id === id);
  if (!t) return;
  document.getElementById('bo-form-title').textContent = `Modifica: ${t.code}`;
  document.getElementById('bo-type-id').value = t.id;
  document.getElementById('bo-code').value = t.code;
  document.getElementById('bo-name').value = t.name;
  document.getElementById('bo-field-label').value = t.target_field_label;
  document.getElementById('bo-unit').value = t.unit || '';
  document.getElementById('bo-hints').value = t.ai_hints || '';
};

window.removeContentType = async function(id) {
  if (!confirm('Vuoi disattivare questa tipologia di contenuto?')) return;
  await ApiService.deleteContentType(id);
  await loadInitialData();
};

function resetBackofficeForm() {
  document.getElementById('bo-form-title').textContent = 'Nuova Tipologia di Contenuto';
  document.getElementById('bo-type-id').value = '';
  document.getElementById('bo-type-form').reset();
}

async function loadHistoryTable() {
  const batches = await ApiService.getRecentBatches();
  const tbody = document.getElementById('hist-tbody');
  tbody.innerHTML = '';

  if (batches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="color:#64748b">Nessuna scansione registrata su Supabase.</td></tr>';
    return;
  }

  batches.forEach(b => {
    const d = new Date(b.created_at).toLocaleString('it-IT');
    const typeLabel = b.doc_content_types ? `${b.doc_content_types.code} - ${b.doc_content_types.name}` : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d}</td>
      <td><strong>${b.filename}</strong></td>
      <td class="text-center">${b.total_pages}</td>
      <td>${typeLabel}</td>
      <td><span class="status-pill ${b.status === 'completed' ? 'status-ok' : 'status-warn'}">${b.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}