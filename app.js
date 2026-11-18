/**
 * CONTROLLER PRINCIPALE DELL'APPLICAZIONE
 * - Rilancio automatico dell'OCR ogni volta che si ridisegna/sposta il rettangolo col mouse
 * - Ritaglio ingrandito (Zoom Crop) dell'area selezionata
 * - Apprendimento continuo (Few-Shot + Spatial Memory) da ogni correzione dell'utente
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const AppState = {
  contentTypes: [],
  pdfDoc: null,
  currentBatch: null,
  pagesData: [],
  currentReviewIndex: 0,
  sessionCorrections: [] // Memoria adattiva accumulata durante la lavorazione del PDF corrente
};

document.addEventListener('DOMContentLoaded', () => {
  const isDbConnected = ApiService.init();
  updateDbStatusBadge(isDbConnected);

  const loginHint = document.getElementById('login-db-hint');
  if (loginHint) {
    loginHint.textContent = isDbConnected
      ? 'Connesso a Supabase — Password verificata su database'
      : 'DB non configurato in config.js (password fallback: admin2026)';
  }

  setupLogin();
  setupNavigation();
  setupSettingsModal();
  setupScannerWorkflow();
  setupBackoffice();

  // Calibrazione Pagina 1: al rilascio del mouse dopo aver disegnato/spostato il rettangolo -> esegue subito nuovo OCR mirato!
  setupBoundingBoxDrawing(
    'cal-canvas-wrapper',
    'cal-bbox',
    (newBox) => {
      if (AppState.pagesData[0]) {
        AppState.pagesData[0].bounding_box = newBox;
        document.getElementById('cal-coords-display').textContent =
          `X:${newBox.x}% Y:${newBox.y}% W:${newBox.w}% H:${newBox.h}%`;
        updateCropPreview('cal-pdf-canvas', 'cal-crop-canvas', newBox);
      }
    },
    async (finalBox) => {
      await runTargetedOcrOnCalibrationBox(finalBox);
    }
  );

  // Revisione Pagina per Pagina: al rilascio del mouse -> esegue subito nuovo OCR mirato + apprende la posizione!
  setupBoundingBoxDrawing(
    'rev-canvas-wrapper',
    'rev-bbox',
    (newBox) => {
      const pageObj = AppState.pagesData[AppState.currentReviewIndex];
      if (pageObj) {
        pageObj.bounding_box = newBox;
        updateCropPreview('rev-pdf-canvas', 'rev-crop-canvas', newBox);
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

    const isValid = await ApiService.verifyAppPassword(passInput.value);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Accedi al Sistema';

    if (isValid) {
      sessionStorage.setItem('docscanner_auth', 'true');
      loginScreen.classList.add('hidden');
      appContainer.classList.remove('hidden');
      loadInitialData();
    } else {
      errorMsg.classList.remove('hidden');
      passInput.value = '';
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
    badge.textContent = 'DB: Modalità Locale (Configura config.js)';
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
    document.getElementById('cfg-ocr-mode').value =
      (ApiService.config.ocrMode === 'simulation') ? 'simulation' : 'edge_gemini';
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
    alert('Ripristinati i parametri di connessione dal file config.js.');
  });

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const connected = ApiService.saveConfig({
      supabaseUrl: document.getElementById('cfg-supabase-url').value.trim(),
      supabaseKey: document.getElementById('cfg-supabase-key').value.trim(),
      ocrMode: document.getElementById('cfg-ocr-mode').value,
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
// 3. WORKFLOW SCANNER + OCR REATTIVO AL RETTANGOLO + APPRENDIMENTO CONTINUO
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

  // Rotazione Pagina 1
  document.getElementById('btn-cal-rot-ccw').addEventListener('click', () => rotateCalibrationPage(-90));
  document.getElementById('btn-cal-rot-180').addEventListener('click', () => rotateCalibrationPage(180));
  document.getElementById('btn-cal-rot-cw').addEventListener('click', () => rotateCalibrationPage(90));
  document.getElementById('btn-cal-reanalyze').addEventListener('click', () => {
    if (AppState.pagesData[0]) runTargetedOcrOnCalibrationBox(AppState.pagesData[0].bounding_box);
  });

  // Rotazione in Revisione
  document.getElementById('btn-rev-rot-ccw').addEventListener('click', () => rotateReviewPage(-90));
  document.getElementById('btn-rev-rot-180').addEventListener('click', () => rotateReviewPage(180));
  document.getElementById('btn-rev-rot-cw').addEventListener('click', () => rotateReviewPage(90));
  document.getElementById('btn-rev-reanalyze').addEventListener('click', () => {
    const p = AppState.pagesData[AppState.currentReviewIndex];
    if (p) runTargetedOcrOnReviewBox(p.bounding_box);
  });

  // Cambio tipologia nel menu a discesa della Pagina 1 -> riposiziona box e rilegge subito
  document.getElementById('cal-type-select').addEventListener('change', async (e) => {
    const selectedType = AppState.contentTypes.find(t => t.id === e.target.value);
    if (selectedType) {
      document.getElementById('cal-unit-label').textContent = selectedType.unit ? `(${selectedType.unit})` : '';
      document.getElementById('cal-bbox-label').textContent = selectedType.target_field_label;
      updateLearnedBadge('cal-learned-count-badge', selectedType);
      if (selectedType.expected_box && AppState.pagesData[0]) {
        AppState.pagesData[0].bounding_box = { ...selectedType.expected_box };
        applyBoundingBox('cal-bbox', selectedType.expected_box);
        updateCropPreview('cal-pdf-canvas', 'cal-crop-canvas', selectedType.expected_box);
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

  // Salva correzione sulla pagina corrente, addestra la memoria AI e passa alla successiva
  document.getElementById('btn-rev-accept-page').addEventListener('click', async () => {
    await saveAndLearnCurrentReviewPage(true);
    if (AppState.currentReviewIndex < AppState.pagesData.length - 1) {
      navigateReview(1, true);
    } else {
      finishReviewAndShowOutput();
    }
  });

  // Riapplica ciò che l'AI ha appreso dalle correzioni fatte finora alle pagine successive non ancora verificate
  document.getElementById('btn-rev-reapply-remaining').addEventListener('click', reapplyLearnedRulesToRemainingPages);

  document.getElementById('btn-rev-finish-all').addEventListener('click', async () => {
    await saveAndLearnCurrentReviewPage(true);
    finishReviewAndShowOutput();
  });

  document.getElementById('btn-export-csv').addEventListener('click', exportReportCsv);
}

// --- NUOVO OCR AUTOMATICO AL RILASCIO DEL RETTANGOLO (CALIBRAZIONE PAGINA 1) ---
async function runTargetedOcrOnCalibrationBox(box) {
  if (!AppState.pagesData[0]) return;
  const liveBadge = document.getElementById('cal-ocr-live-badge');
  liveBadge.textContent = 'Lettura OCR area...';
  liveBadge.classList.remove('hidden');

  const fullCanvas = document.getElementById('cal-pdf-canvas');
  const fullBase64 = fullCanvas.toDataURL('image/jpeg', 0.85);
  const croppedBase64 = updateCropPreview('cal-pdf-canvas', 'cal-crop-canvas', box);

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

  AppState.pagesData[0].detected_value = res.detected_value;
  AppState.pagesData[0].confidence = res.confidence;
  AppState.pagesData[0].bounding_box = box;

  const matchedType = AppState.contentTypes.find(t => t.id === selectedTypeId);
  document.getElementById('cal-value-input').value = res.detected_value;
  document.getElementById('cal-confidence').textContent = `${Math.round(res.confidence * 100)}%`;
  document.getElementById('cal-bbox-label').textContent = `${matchedType?.target_field_label || 'Valore'}: ${res.detected_value}`;

  liveBadge.textContent = '✓ Area letta';
  setTimeout(() => liveBadge.classList.add('hidden'), 1500);
}

// --- NUOVO OCR AUTOMATICO AL RILASCIO DEL RETTANGOLO (REVISIONE PAGINA N) ---
async function runTargetedOcrOnReviewBox(box) {
  const pageObj = AppState.pagesData[AppState.currentReviewIndex];
  if (!pageObj) return;

  const liveBadge = document.getElementById('rev-ocr-live-badge');
  liveBadge.textContent = 'Lettura OCR area...';
  liveBadge.classList.remove('hidden');

  const fullCanvas = document.getElementById('rev-pdf-canvas');
  const fullBase64 = fullCanvas.toDataURL('image/jpeg', 0.85);
  const croppedBase64 = updateCropPreview('rev-pdf-canvas', 'rev-crop-canvas', box);

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

  pageObj.detected_value = res.detected_value;
  pageObj.confidence = res.confidence;
  pageObj.bounding_box = box;
  pageObj.box_moved_by_user = true;

  const matchedType = AppState.contentTypes.find(t => t.id === selectedTypeId);
  document.getElementById('rev-value-input').value = res.detected_value;
  document.getElementById('rev-confidence').textContent = `${Math.round(res.confidence * 100)}%`;
  document.getElementById('rev-bbox-label').textContent = `${matchedType?.code || 'Valore'}: ${res.detected_value}`;
  updateRunningSumDisplay();

  liveBadge.textContent = '✓ Area letta';
  setTimeout(() => liveBadge.classList.add('hidden'), 1500);
}

// --- ROTAZIONE PAGINE ---
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
  if (!AppState.pagesData[0]) return;
  const newRot = normalizeAngle((AppState.pagesData[0].rotation || 0) + deltaDegrees);
  AppState.pagesData[0].rotation = newRot;

  document.getElementById('cal-rot-badge').textContent = `${newRot}°`;
  document.getElementById('cal-rot-meta').textContent = formatRotationLabel(newRot);

  await renderPdfPageToCanvas(1, 'cal-pdf-canvas', newRot);
  updateCropPreview('cal-pdf-canvas', 'cal-crop-canvas', AppState.pagesData[0].bounding_box);
  await runTargetedOcrOnCalibrationBox(AppState.pagesData[0].bounding_box);
}

async function rotateReviewPage(deltaDegrees) {
  const pageObj = AppState.pagesData[AppState.currentReviewIndex];
  if (!pageObj) return;
  const newRot = normalizeAngle((pageObj.rotation || 0) + deltaDegrees);
  pageObj.rotation = newRot;

  document.getElementById('rev-rot-badge').textContent = `${newRot}°`;
  document.getElementById('rev-rot-meta').textContent = formatRotationLabel(newRot);

  await renderPdfPageToCanvas(pageObj.page_number, 'rev-pdf-canvas', newRot);
  updateCropPreview('rev-pdf-canvas', 'rev-crop-canvas', pageObj.bounding_box);
  await runTargetedOcrOnReviewBox(pageObj.bounding_box);
}

// --- CARICAMENTO PDF E ANALISI PAGINA 1 ---
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

  document.getElementById('cal-total-pages').textContent = totalPages;
  document.getElementById('cal-rot-badge').textContent = '0°';
  document.getElementById('cal-rot-meta').textContent = formatRotationLabel(0);
  setScannerStep(2);

  const base64Page1 = await renderPdfPageToCanvas(1, 'cal-pdf-canvas', 0);
  const analysis = await ApiService.analyzePageImage(base64Page1, 1, AppState.contentTypes, null);

  AppState.pagesData[0] = {
    page_number: 1,
    detected_type_id: analysis.detected_type_id,
    ai_initial_value: analysis.detected_value,
    detected_value: analysis.detected_value,
    bounding_box: analysis.bounding_box,
    rotation: 0,
    confidence: analysis.confidence,
    is_verified: false,
    notes: ''
  };

  populateTypeSelects();
  const typeSelect = document.getElementById('cal-type-select');
  typeSelect.value = analysis.detected_type_id;

  const matchedType = AppState.contentTypes.find(t => t.id === analysis.detected_type_id);
  updateLearnedBadge('cal-learned-count-badge', matchedType);
  document.getElementById('cal-unit-label').textContent = matchedType?.unit ? `(${matchedType.unit})` : '';
  document.getElementById('cal-bbox-label').textContent = `${matchedType?.target_field_label || 'Valore'}: ${analysis.detected_value}`;
  document.getElementById('cal-value-input').value = analysis.detected_value;
  document.getElementById('cal-confidence').textContent = `${Math.round(analysis.confidence * 100)}%`;
  document.getElementById('cal-coords-display').textContent =
    `X:${analysis.bounding_box.x}% Y:${analysis.bounding_box.y}% W:${analysis.bounding_box.w}% H:${analysis.bounding_box.h}%`;

  applyBoundingBox('cal-bbox', analysis.bounding_box);
  updateCropPreview('cal-pdf-canvas', 'cal-crop-canvas', analysis.bounding_box);
}

// --- ELABORAZIONE MASSIVA PAGINE 2..N CON APPRENDIMENTO DA PAGINA 1 ---
async function processRemainingPages() {
  const confirmedTypeId = document.getElementById('cal-type-select').value;
  const confirmedValue = parseFloat(document.getElementById('cal-value-input').value) || 0;
  const confirmedBox = AppState.pagesData[0].bounding_box;
  const inheritedRotation = AppState.pagesData[0].rotation || 0;

  AppState.pagesData[0].detected_type_id = confirmedTypeId;
  AppState.pagesData[0].detected_value = confirmedValue;
  AppState.pagesData[0].is_verified = true;

  // Registra la conferma/correzione della Pagina 1 nella memoria di sessione e sul DB
  const correctionRecord = {
    page: 1,
    type_id: confirmedTypeId,
    ai_initial_value: AppState.pagesData[0].ai_initial_value,
    confirmed_value: confirmedValue,
    box: confirmedBox,
    note: 'Calibrazione Pagina 1'
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
    statusText.textContent = `Analisi adattiva Pagina ${p} di ${total} (applicando regole apprese)...`;

    const base64Img = await renderPdfPageToElement(p, offscreenCanvas, inheritedRotation);
    const res = await ApiService.analyzePageImage(base64Img, p, AppState.contentTypes, {
      primaryTypeId: confirmedTypeId,
      referenceBox: confirmedBox,
      sessionCorrections: AppState.sessionCorrections
    });

    AppState.pagesData[p - 1] = {
      page_number: p,
      detected_type_id: res.detected_type_id,
      ai_initial_value: res.detected_value,
      detected_value: res.detected_value,
      bounding_box: res.bounding_box,
      rotation: inheritedRotation,
      confidence: res.confidence,
      is_verified: false,
      notes: ''
    };
  }

  progressBar.style.width = '100%';
  await ApiService.savePagesBulk(AppState.currentBatch.id, AppState.pagesData);
  await ApiService.updateBatch(AppState.currentBatch.id, { status: 'pending_approval' });

  renderDecisionSummary();
  setScannerStep(4);
}

// --- STEP 4: RIEPILOGO SOMME E DECISION GATE ---
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

// --- STEP 5B: REVISIONE PAGINA PER PAGINA + APPRENDIMENTO CONTINUO ---
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
  document.getElementById('rev-confidence').textContent = `${Math.round(pageData.confidence * 100)}%`;

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
  updateCropPreview('rev-pdf-canvas', 'rev-crop-canvas', pageData.bounding_box);
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

  // Se l'utente ha corretto il valore, spostato il riquadro o cambiato tipologia, l'AI apprende subito!
  if (wasModified && markVerified) {
    const correctionRecord = {
      page: pageData.page_number,
      type_id: newTypeId,
      ai_initial_value: pageData.ai_initial_value,
      confirmed_value: newVal,
      box: pageData.bounding_box,
      note: newNotes || `Correzione Pagina ${pageData.page_number}`
    };
    AppState.sessionCorrections.push(correctionRecord);

    const typeObj = AppState.contentTypes.find(t => t.id === newTypeId);
    if (typeObj) {
      await ApiService.recordHumanCorrection(typeObj, correctionRecord);
    }

    // Mostra il pulsante per ri-analizzare automaticamente le pagine rimanenti con le nuove regole apprese
    const remainingUnverified = AppState.pagesData.slice(AppState.currentReviewIndex + 1).filter(p => !p.is_verified);
    if (remainingUnverified.length > 0) {
      const reapplyBtn = document.getElementById('btn-rev-reapply-remaining');
      reapplyBtn.textContent = `🧠 Rianalizza le ${remainingUnverified.length} Pagine Successive con le Regole Apprese`;
      reapplyBtn.classList.remove('hidden');
    }
  }

  updateRunningSumDisplay();
}

async function reapplyLearnedRulesToRemainingPages() {
  const btn = document.getElementById('btn-rev-reapply-remaining');
  btn.disabled = true;
  const offscreenCanvas = document.createElement('canvas');

  const latestCorrection = AppState.sessionCorrections[AppState.sessionCorrections.length - 1];
  const targetTypeId = latestCorrection?.type_id || AppState.pagesData[AppState.currentReviewIndex].detected_type_id;
  const targetBox = latestCorrection?.box || AppState.pagesData[AppState.currentReviewIndex].bounding_box;

  for (let i = AppState.currentReviewIndex + 1; i < AppState.pagesData.length; i++) {
    const p = AppState.pagesData[i];
    if (p.is_verified) continue;

    btn.textContent = `⏳ Ricalibrazione AI Pagina ${p.page_number} di ${AppState.pagesData.length}...`;
    const base64Img = await renderPdfPageToElement(p.page_number, offscreenCanvas, p.rotation || 0);
    const res = await ApiService.analyzePageImage(base64Img, p.page_number, AppState.contentTypes, {
      primaryTypeId: targetTypeId,
      referenceBox: targetBox,
      sessionCorrections: AppState.sessionCorrections
    });

    p.detected_type_id = res.detected_type_id;
    p.ai_initial_value = res.detected_value;
    p.detected_value = res.detected_value;
    p.bounding_box = res.bounding_box;
    p.confidence = res.confidence;
  }

  btn.disabled = false;
  btn.classList.add('hidden');
  updateRunningSumDisplay();
  alert('Pagine successive rianalizzate con successo applicando le ultime correzioni!');
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

// --- STEP 5A: OUTPUT FINALE ---
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
// 4. UTILITY PDF.JS, ZOOM CROP & BOUNDING BOX INTERATTIVO
// ============================================================================
async function renderPdfPageToCanvas(pageNum, canvasId, extraRotation = 0) {
  const canvas = document.getElementById(canvasId);
  return await renderPdfPageToElement(pageNum, canvas, extraRotation);
}

async function renderPdfPageToElement(pageNum, canvasEl, extraRotation = 0) {
  const page = await AppState.pdfDoc.getPage(pageNum);
  const nativeRotation = page.rotate || 0;
  const totalRotation = normalizeAngle(nativeRotation + extraRotation);

  const viewport = page.getViewport({ scale: 1.5, rotation: totalRotation });
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = viewport.width;
  canvasEl.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvasEl.toDataURL('image/jpeg', 0.85);
}

function updateCropPreview(sourceCanvasId, cropCanvasId, box) {
  const srcCanvas = document.getElementById(sourceCanvasId);
  const dstCanvas = document.getElementById(cropCanvasId);
  if (!srcCanvas || !dstCanvas || !box || srcCanvas.width === 0) return null;

  const sx = Math.max(0, Math.floor((box.x / 100) * srcCanvas.width));
  const sy = Math.max(0, Math.floor((box.y / 100) * srcCanvas.height));
  const sw = Math.max(10, Math.floor((box.w / 100) * srcCanvas.width));
  const sh = Math.max(10, Math.floor((box.h / 100) * srcCanvas.height));

  dstCanvas.width = sw;
  dstCanvas.height = sh;
  const ctx = dstCanvas.getContext('2d');
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return dstCanvas.toDataURL('image/jpeg', 0.92);
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