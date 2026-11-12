// ==========================================
// 內部機密資料檢視系統 - 前端核心腳本
// ==========================================

let currentUser = null;
let currentClientIp = '127.0.0.1';
let fullTableData = null;
let filteredRows = [];
let currentPage = 1;
const rowsPerPage = 15;
let watermarkTimer = null;

// DOM Elements
const loginContainer = document.getElementById('login-container');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const loginAlert = document.getElementById('login-alert');
const btnLogout = document.getElementById('btn-logout');
const userDisplayName = document.getElementById('user-display-name');
const userRoleBadge = document.getElementById('user-role-badge');
const adminNav = document.getElementById('admin-nav');
const navBtnData = document.getElementById('nav-btn-data');
const navBtnAdmin = document.getElementById('nav-btn-admin');
const sectionDataView = document.getElementById('section-data-view');
const sectionAdminView = document.getElementById('section-admin-view');

// ==========================================
// 1. 動態防外洩浮水印引擎 (Watermark Engine)
// ==========================================

function generateWatermarkCanvas(user, ip) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // 設定重複單元格大小
  const width = 360;
  const height = 240;
  canvas.width = width;
  canvas.height = height;

  const now = new Date();
  const timeString = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');

  // 傾斜旋轉繪製浮水印字樣
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-28 * Math.PI) / 180);

  ctx.font = 'bold 15px sans-serif';
  ctx.fillStyle = 'rgba(71, 85, 105, 0.14)'; // 半透明 Slate 顏色
  ctx.textAlign = 'center';

  const line1 = `${user.displayName || user.username} (${user.username})`;
  const line2 = `IP: ${ip} | ${timeString}`;
  const line3 = '機密資料 嚴禁截圖與外洩';

  ctx.fillText(line1, 0, -12);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = 'rgba(71, 85, 105, 0.12)';
  ctx.fillText(line2, 0, 8);
  ctx.font = 'italic 11px sans-serif';
  ctx.fillStyle = 'rgba(225, 29, 72, 0.12)'; // 警告紅字淡淡的
  ctx.fillText(line3, 0, 26);

  return canvas.toDataURL('image/png');
}

function applyWatermark(user, ip) {
  let overlay = document.getElementById('security-watermark-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'security-watermark-overlay';
    document.body.appendChild(overlay);
  }

  const watermarkDataUrl = generateWatermarkCanvas(user, ip);
  overlay.style.backgroundImage = `url("${watermarkDataUrl}")`;

  // 啟動 DOM 防竄改監聽器 (防止使用者透過 F12 檢查元素隱藏或刪除浮水印)
  setupWatermarkObserver(user, ip);
}

// 防竄改監控 (MutationObserver)
let observerActive = false;
function setupWatermarkObserver(user, ip) {
  if (observerActive) return;
  observerActive = true;

  const observer = new MutationObserver((mutations) => {
    let overlay = document.getElementById('security-watermark-overlay');
    
    // 如果元素被刪除，立即重建
    if (!overlay) {
      applyWatermark(user, ip);
      return;
    }

    // 如果元素的樣式被竄改 (例如改為 display:none 或 opacity:0)
    const style = window.getComputedStyle(overlay);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) < 0.5 ||
      overlay.style.backgroundImage === ''
    ) {
      overlay.style.display = 'block';
      overlay.style.visibility = 'visible';
      overlay.style.opacity = '1';
      overlay.style.backgroundImage = `url("${generateWatermarkCanvas(user, ip)}")`;
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
}

function startWatermarkRefresh(user, ip) {
  applyWatermark(user, ip);
  if (watermarkTimer) clearInterval(watermarkTimer);
  // 每 30 秒自動更新時間戳記浮水印
  watermarkTimer = setInterval(() => {
    applyWatermark(user, ip);
  }, 30000);
}

function stopWatermark() {
  if (watermarkTimer) clearInterval(watermarkTimer);
  const overlay = document.getElementById('security-watermark-overlay');
  if (overlay) {
    overlay.style.backgroundImage = 'none';
  }
}

// ==========================================
// 2. 認證與狀態管理 (Auth & Session)
// ==========================================

function getAuthToken() {
  return localStorage.getItem('auth_token') || '';
}

// 統一 API 請求包裝：自動攜帶 Token 與 Cookie，解決反向代理連線中斷問題
function authFetch(url, options = {}) {
  const headers = options.headers || {};
  const token = getAuthToken();
  if (token) {
    if (headers instanceof Headers) {
      headers.set('x-auth-token', token);
    } else {
      headers['x-auth-token'] = token;
    }
  }
  options.headers = headers;
  options.credentials = 'include';
  return fetch(url, options);
}

async function checkAuth() {
  try {
    const res = await authFetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.user;
      currentClientIp = data.clientIp;
      showApp();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('Check auth error:', err);
    showLogin();
  }
}

function showLogin() {
  stopWatermark();
  loginContainer.classList.remove('hidden');
  appContainer.classList.add('hidden');
}

function showApp() {
  loginContainer.classList.add('hidden');
  appContainer.classList.remove('hidden');

  userDisplayName.textContent = currentUser.displayName || currentUser.username;
  userRoleBadge.textContent = currentUser.role === 'admin' ? '管理員' : '一般員工';
  if (currentUser.role === 'admin') {
    userRoleBadge.className = 'ml-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700 font-semibold';
    adminNav.classList.remove('hidden');
  } else {
    userRoleBadge.className = 'ml-1 px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-700 font-semibold';
    adminNav.classList.add('hidden');
  }

  // 立即套用並定時更新身分浮水印
  startWatermarkRefresh(currentUser, currentClientIp);

  // 載入可用檔案清單與表格資料
  loadAvailableFiles();

  if (currentUser.role === 'admin') {
    loadUsersList();
    loadAdminFileList();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginAlert.classList.add('hidden');

  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const submitBtn = document.getElementById('btn-login-submit');

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="ph ph-spinner animate-spin"></i><span>登入中...</span>';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include',
    });

    const data = await res.json();
    if (res.ok) {
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
      }
      currentUser = data.user;
      currentClientIp = data.clientIp;
      showApp();
    } else {
      loginAlert.textContent = data.error || '登入失敗，請確認帳號密碼';
      loginAlert.classList.remove('hidden');
    }
  } catch (err) {
    loginAlert.textContent = '連線伺服器失敗，請稍候再試';
    loginAlert.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>安全登入</span><i class="ph ph-arrow-right font-bold"></i>';
  }
});

btnLogout.addEventListener('click', async () => {
  try {
    await authFetch('/api/logout', { method: 'POST' });
  } finally {
    localStorage.removeItem('auth_token');
    currentUser = null;
    showLogin();
  }
});

// 管理員導航分頁切換
navBtnData.addEventListener('click', () => {
  navBtnData.className = 'px-3 py-1.5 rounded-lg font-medium bg-white text-indigo-600 shadow-sm transition';
  navBtnAdmin.className = 'px-3 py-1.5 rounded-lg font-medium text-slate-600 hover:text-slate-900 transition';
  sectionDataView.classList.remove('hidden');
  sectionAdminView.classList.add('hidden');
});

navBtnAdmin.addEventListener('click', () => {
  navBtnAdmin.className = 'px-3 py-1.5 rounded-lg font-medium bg-white text-indigo-600 shadow-sm transition';
  navBtnData.className = 'px-3 py-1.5 rounded-lg font-medium text-slate-600 hover:text-slate-900 transition';
  sectionAdminView.classList.remove('hidden');
  sectionDataView.classList.add('hidden');
  loadAdminFileList();
  loadUsersList();
});

// ==========================================
// 3. 多檔案切換、大分類篩選、Excel 欄位篩選與排序
// ==========================================

let currentCategory = 'all'; // 'all' (全部), '條件與階段', '實績表'
let allFilesList = []; // 伺服器端所有檔案清單快取
let activeColumnFilters = {}; // 各欄位篩選集合: { [colIndex]: Set(['值1', '值2']) }
let currentFilterPopupCol = -1; // 正在開啟篩選浮動窗的欄位索引

const fileSelector = document.getElementById('file-selector');
if (fileSelector) {
  fileSelector.addEventListener('change', (e) => {
    if (e.target.value) {
      loadFileById(e.target.value);
    }
  });
}

// 切換大類別標籤 (全部檔案 / 條件與階段 / 實績表)
window.switchCategory = function (cat) {
  currentCategory = cat;

  const tabAll = document.getElementById('tab-cat-all');
  const tabConditions = document.getElementById('tab-cat-conditions');
  const tabPerformance = document.getElementById('tab-cat-performance');

  const defaultBtnClass = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200';
  if (tabAll) tabAll.className = defaultBtnClass;
  if (tabConditions) tabConditions.className = defaultBtnClass;
  if (tabPerformance) tabPerformance.className = defaultBtnClass;

  if (cat === 'all' && tabAll) {
    tabAll.className = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm bg-indigo-600 text-white';
  } else if (cat === '條件與階段' && tabConditions) {
    tabConditions.className = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm bg-emerald-600 text-white';
  } else if (cat === '實績表' && tabPerformance) {
    tabPerformance.className = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm bg-amber-600 text-white';
  }

  renderFileSelector();
};

// 依據目前選定之大類別過濾並渲染前台檔案下拉選單
function renderFileSelector(preferredFileId = null) {
  const selector = document.getElementById('file-selector');
  if (!selector) return;

  const visibleFiles = currentCategory === 'all'
    ? allFilesList
    : allFilesList.filter((f) => (f.category || '條件與階段') === currentCategory);

  if (visibleFiles.length === 0) {
    selector.innerHTML = `<option value="">(「${currentCategory === 'all' ? '全部' : currentCategory}」尚無任何檔案)</option>`;
    document.getElementById('table-filename').textContent = `尚無「${currentCategory === 'all' ? '任何' : currentCategory}」表格`;
    document.getElementById('table-total-badge').textContent = '0 筆資料';
    const catTag = document.getElementById('table-category-tag');
    if (catTag) catTag.classList.add('hidden');
    document.getElementById('table-meta-info').textContent = '請至「上傳與後台」上傳該分類之 Excel 或 PDF 文件';
    document.getElementById('table-body').innerHTML = `
      <tr><td colspan="10" class="py-12 text-center text-slate-400">目前「${escapeHtml(currentCategory)}」分類尚無發布檔案</td></tr>
    `;
    const excelContainer = document.getElementById('excel-table-container');
    const pdfContainer = document.getElementById('pdf-doc-container');
    if (excelContainer) excelContainer.classList.remove('hidden');
    if (pdfContainer) pdfContainer.classList.add('hidden');
    return;
  }

  let optionsHtml = '';
  visibleFiles.forEach((file) => {
    const isPerf = file.category === '實績表';
    const isPdf = file.fileType === 'pdf';
    const tag = isPdf ? '【PDF】' : (isPerf ? '【實績表】' : '【條件與階段】');
    optionsHtml += `<option value="${escapeHtml(file.id)}">${tag} ${escapeHtml(file.fileName)} (${file.totalRows || 0} 筆)</option>`;
  });
  selector.innerHTML = optionsHtml;

  let targetId = preferredFileId;
  if (!targetId || !visibleFiles.some((f) => f.id === targetId)) {
    targetId = visibleFiles[0].id;
  }
  selector.value = targetId;

  loadFileById(targetId);
}
    // 當前分類沒有檔案時，預設隱藏 Word 檢視區並顯示 Excel 空白提示
    const excelContainer = document.getElementById('excel-table-container');
    const wordContainer = document.getElementById('word-doc-container');
    if (excelContainer) excelContainer.classList.remove('hidden');
    if (wordContainer) wordContainer.classList.add('hidden');
    return;
  }

  let optionsHtml = '';
  visibleFiles.forEach((file) => {
    const isPerf = file.category === '實績表';
    const isWord = file.fileType === 'word';
    // 增加選單中的 Word 標籤
    const tag = isWord ? '【Word】' : (isPerf ? '【實績表】' : '【條件與階段】');
    optionsHtml += `<option value="${escapeHtml(file.id)}">${tag} ${escapeHtml(file.fileName)} (${file.totalRows || 0} 筆)</option>`;
  });
  selector.innerHTML = optionsHtml;

  let targetId = preferredFileId;
  if (!targetId || !visibleFiles.some((f) => f.id === targetId)) {
    targetId = visibleFiles[0].id;
  }
  selector.value = targetId;

  loadFileById(targetId);
}

// 載入所有可用檔案清單
async function loadAvailableFiles(preferredFileId = null) {
  try {
    const res = await authFetch('/api/files');
    const data = await res.json();
    allFilesList = data.files || [];
    renderFileSelector(preferredFileId);
  } catch (err) {
    console.error('Load available files failed:', err);
  }
}

// 排序狀態管理變數
let currentSortColumn = -1; // -1 表示使用原始上傳順序
let currentSortDirection = 'asc'; // 'asc' 或 'desc'

// 依據檔案 ID 載入詳細多欄多行資料
async function loadFileById(fileId) {
  if (!fileId) return;
  try {
    const res = await authFetch('/api/files/' + encodeURIComponent(fileId));
    const data = await res.json();
    if (data.file) {
      fullTableData = data.file;
      currentSortColumn = -1;
      currentSortDirection = 'asc';
      activeColumnFilters = {}; // 切換新檔案時重設欄位篩選

      const excelContainer = document.getElementById('excel-table-container');
      const pdfContainer = document.getElementById('pdf-doc-container');
      const pdfViewer = document.getElementById('pdf-doc-viewer');
      const searchInput = document.getElementById('search-input');

      if (fullTableData.fileType === 'pdf') {
        if (excelContainer) excelContainer.classList.add('hidden');
        if (pdfContainer) pdfContainer.classList.remove('hidden');
        if (pdfViewer) {
          pdfViewer.innerHTML = '<div class="text-center py-12 text-slate-400"><i class="ph ph-spinner animate-spin text-2xl mb-2"></i><div>正在載入安全加密 PDF 文件中...</div></div>';
          try {
            // 🌟 透過二進位串流取得 PDF 並由 PDF.js 渲染為 Canvas，100% 原版格線，防止文字反白複製
            const rawRes = await authFetch('/api/files/' + encodeURIComponent(fileId) + '/raw');
            if (rawRes.ok) {
              const arrayBuffer = await rawRes.arrayBuffer();
              pdfViewer.innerHTML = ''; // 清空載入圖示

              const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
              const pdf = await loadingTask.promise;

              // 逐頁渲染 PDF
              for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);

                const pageContainer = document.createElement('div');
                pageContainer.className = 'flex justify-center mb-6 bg-white p-2 shadow-lg rounded-md border border-slate-200 relative';

                const canvas = document.createElement('canvas');
                canvas.className = 'max-w-full';
                const ctx = canvas.getContext('2d');

                // 設定清晰度 (1.5倍縮放保證清晰)
                const viewport = page.getViewport({ scale: 1.5 });
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                pageContainer.appendChild(canvas);
                pdfViewer.appendChild(pageContainer);

                await page.render({
                  canvasContext: ctx,
                  viewport: viewport
                }).promise;
              }
            } else {
              pdfViewer.innerHTML = '<div class="text-center py-12 text-rose-500">❌ 載入原始 PDF 文件失敗。</div>';
            }
          } catch (pdfErr) {
            console.error("PDF.js 渲染錯誤:", pdfErr);
            pdfViewer.innerHTML = '<div class="text-center py-12 text-rose-500">❌ PDF 檔案解析或渲染失敗，請確認檔案格式是否正確。</div>';
          }
        }
        if (searchInput) {
          searchInput.disabled = true;
          searchInput.placeholder = "PDF 檔案不支援表格篩選與搜尋";
          searchInput.value = "";
        }
      } else {
        if (excelContainer) excelContainer.classList.remove('hidden');
        if (pdfContainer) pdfContainer.classList.add('hidden');
        if (pdfViewer) pdfViewer.innerHTML = '';
        if (searchInput) {
          searchInput.disabled = false;
          searchInput.placeholder = "在當前表格中搜尋...";
        }
        applySearchAndSort();
      }
      renderTableMeta();
    }
  } catch (err) {
    console.error('Load file detail failed:', err);
  }
}

      // 關鍵修復：判斷檔案類型是否為 PDF
      if (fullTableData.fileType === 'PDF') {
        if (excelContainer) excelContainer.classList.add('hidden');
        if (wordContainer) wordContainer.classList.remove('hidden');
        if (wordViewer) wordViewer.innerHTML = fullTableData.htmlContent || '';
        if (searchInput) {
          searchInput.disabled = true;
          searchInput.placeholder = "PDF 文件不支援表格篩選與搜尋";
          searchInput.value = "";
        }
      } else {
        if (excelContainer) excelContainer.classList.remove('hidden');
        if (wordContainer) wordContainer.classList.add('hidden');
        if (wordViewer) wordViewer.innerHTML = '';
        if (searchInput) {
          searchInput.disabled = false;
          searchInput.placeholder = "在當前表格中搜尋...";
        }
        applySearchAndSort(); // 只有 Excel 才執行表格搜尋排序
      }
      renderTableMeta();
    }
  } catch (err) {
    console.error('Load file detail failed:', err);
  }
}

// 點擊表頭標題切換排序 (升冪 -> 降冪 -> 重設)
window.handleSort = function (colIndex) {
  if (currentSortColumn === colIndex) {
    if (currentSortDirection === 'asc') {
      currentSortDirection = 'desc';
    } else {
      currentSortColumn = -1;
      currentSortDirection = 'asc';
    }
  } else {
    currentSortColumn = colIndex;
    currentSortDirection = 'asc';
  }
  applySearchAndSort();
};

window.resetSort = function () {
  currentSortColumn = -1;
  currentSortDirection = 'asc';
  applySearchAndSort();
};

function renderSortStatusPill() {
  const pill = document.getElementById('sort-status-pill');
  const pillText = document.getElementById('sort-pill-text');
  const pillIcon = document.getElementById('sort-pill-icon');
  if (!pill) return;

  if (currentSortColumn >= 0 && fullTableData && fullTableData.headers[currentSortColumn]) {
    const headerName = fullTableData.headers[currentSortColumn];
    const dirText = currentSortDirection === 'asc' ? '升冪 (小 ➔ 大 / A ➔ Z)' : '降冪 (大 ➔ 小 / Z ➔ A)';
    pillText.textContent = `已依「${headerName}」${dirText}`;
    pillIcon.className = currentSortDirection === 'asc'
      ? 'ph ph-sort-ascending text-sm text-indigo-600 font-bold'
      : 'ph ph-sort-descending text-sm text-indigo-600 font-bold';
    pill.classList.remove('hidden');
    pill.classList.add('inline-flex');
  } else {
    pill.classList.add('hidden');
    pill.classList.remove('inline-flex');
  }
}

function renderFilterStatusPill() {
  const pill = document.getElementById('filter-status-pill');
  const pillText = document.getElementById('filter-pill-text');
  if (!pill) return;

  const filteredColKeys = Object.keys(activeColumnFilters);
  if (filteredColKeys.length > 0 && fullTableData) {
    const colNames = filteredColKeys
      .map((k) => fullTableData.headers[parseInt(k, 10)])
      .filter(Boolean)
      .join('、');
    pillText.textContent = `已篩選欄位：${colNames}`;
    pill.classList.remove('hidden');
    pill.classList.add('inline-flex');
  } else {
    pill.classList.add('hidden');
    pill.classList.remove('inline-flex');
  }
}

// 產生帶有 Excel 風格篩選按鈕與排序狀態的表格標題
function renderTableHeaders() {
  const thead = document.getElementById('table-head');
  let headerHtml = '<tr><th class="py-3.5 px-4 text-center w-14 bg-slate-100 font-bold text-slate-700">#</th>';

  fullTableData.headers.forEach((headerText, colIdx) => {
    const isSorted = currentSortColumn === colIdx;
    const isFiltered = activeColumnFilters[colIdx] !== undefined;

    let thBg = 'hover:bg-slate-100';
    if (isSorted) {
      thBg = 'bg-indigo-50/70 hover:bg-indigo-100/70 text-indigo-900';
    }

    let sortIconHtml = '';
    if (isSorted) {
      sortIconHtml = currentSortDirection === 'asc'
        ? '<i class="ph ph-arrow-up text-indigo-600 text-xs font-bold mr-1"></i>'
        : '<i class="ph ph-arrow-down text-indigo-600 text-xs font-bold mr-1"></i>';
    }

    // 篩選按鈕圖示 (若已篩選則亮起漏斗圖示)
    const filterBtnClass = isFiltered
      ? 'bg-indigo-600 text-white shadow-sm'
      : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200/60';
    const filterIcon = isFiltered ? 'ph-funnel-simple' : 'ph-caret-down';

    headerHtml += `
      <th class="group py-3 px-3 font-semibold text-slate-700 whitespace-nowrap select-none ${thBg}">
        <div class="flex items-center justify-between gap-2">
          <div onclick="handleSort(${colIdx})" title="點擊排序" class="cursor-pointer flex items-center flex-1 truncate">
            ${sortIconHtml}
            <span class="truncate">${escapeHtml(headerText)}</span>
          </div>
          <button type="button" onclick="openColumnFilterPopup(event, ${colIdx})" title="Excel 條件篩選與排序"
            class="p-1 rounded-md text-xs transition shrink-0 ${filterBtnClass}">
            <i class="ph ${filterIcon} font-bold text-xs"></i>
          </button>
        </div>
      </th>
    `;
  });

  headerHtml += '</tr>';
  thead.innerHTML = headerHtml;
}

// ==========================================
// Excel 風格欄位篩選彈窗邏輯
// ==========================================

window.openColumnFilterPopup = function (event, colIndex) {
  event.stopPropagation();
  currentFilterPopupCol = colIndex;

  const popup = document.getElementById('column-filter-popup');
  const colNameSpan = document.getElementById('popup-column-name');
  const searchInput = document.getElementById('popup-search-input');
  const valuesListDiv = document.getElementById('popup-values-list');
  const selectAllBox = document.getElementById('popup-select-all');

  if (!fullTableData || !fullTableData.headers[colIndex]) return;

  colNameSpan.textContent = `篩選「${fullTableData.headers[colIndex]}」`;
  if (searchInput) searchInput.value = '';

  // 統計所有不重複值與筆數
  const valueCounts = {};
  fullTableData.rows.forEach((row) => {
    const raw = row[colIndex] !== null && row[colIndex] !== undefined ? String(row[colIndex]).trim() : '';
    const key = raw === '' ? '(空白)' : raw;
    valueCounts[key] = (valueCounts[key] || 0) + 1;
  });

  const sortedValues = Object.keys(valueCounts).sort((a, b) =>
    a.localeCompare(b, 'zh-Hant', { numeric: true })
  );

  const currentAllowed = activeColumnFilters[colIndex] || null;

  let listHtml = '';
  sortedValues.forEach((val) => {
    const isChecked = currentAllowed === null || currentAllowed.has(val);
    listHtml += `
      <label class="flex items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-white cursor-pointer transition text-xs">
        <div class="flex items-center gap-1.5 truncate">
          <input type="checkbox" class="col-filter-checkbox rounded text-indigo-600 focus:ring-indigo-500"
            data-val="${escapeHtml(val)}" ${isChecked ? 'checked' : ''} onchange="updatePopupCount()">
          <span class="truncate text-slate-700" title="${escapeHtml(val)}">${escapeHtml(val)}</span>
        </div>
        <span class="text-[10px] text-slate-400 font-mono">(${valueCounts[val]})</span>
      </label>
    `;
  });
  valuesListDiv.innerHTML = listHtml;

  updatePopupCount();

  // 定位彈窗在按鈕周圍，並做邊界防溢出處理
  const rect = event.currentTarget.getBoundingClientRect();
  const top = Math.min(rect.bottom + window.scrollY + 6, window.innerHeight + window.scrollY - 380);
  const left = Math.min(Math.max(10, rect.left + window.scrollX - 160), window.innerWidth - 300);

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
  popup.classList.remove('hidden');

  // 即時搜尋過濾清單
  if (searchInput) {
    searchInput.oninput = function () {
      const q = searchInput.value.trim().toLowerCase();
      const labels = valuesListDiv.querySelectorAll('label');
      labels.forEach((l) => {
        const text = l.innerText.toLowerCase();
        l.style.display = text.includes(q) ? 'flex' : 'none';
      });
    };
  }

  // 全選按鈕控制
  if (selectAllBox) {
    selectAllBox.onchange = function () {
      const checkboxes = valuesListDiv.querySelectorAll('.col-filter-checkbox');
      checkboxes.forEach((cb) => {
        if (cb.closest('label').style.display !== 'none') {
          cb.checked = selectAllBox.checked;
        }
      });
      updatePopupCount();
    };
  }
};

window.updatePopupCount = function () {
  const checkboxes = document.querySelectorAll('.col-filter-checkbox');
  const checked = Array.from(checkboxes).filter((cb) => cb.checked);
  const selectAllBox = document.getElementById('popup-select-all');
  const countSpan = document.getElementById('popup-selected-count');

  if (countSpan) countSpan.textContent = `${checked.length} / ${checkboxes.length} 項`;
  if (selectAllBox) selectAllBox.checked = checked.length === checkboxes.length;
};

window.closeColumnFilterPopup = function () {
  const popup = document.getElementById('column-filter-popup');
  if (popup) popup.classList.add('hidden');
  currentFilterPopupCol = -1;
};

window.popupSort = function (dir) {
  if (currentFilterPopupCol >= 0) {
    currentSortColumn = currentFilterPopupCol;
    currentSortDirection = dir;
    closeColumnFilterPopup();
    applySearchAndSort();
  }
};

window.popupApplyFilter = function () {
  if (currentFilterPopupCol < 0) return;
  const colIndex = currentFilterPopupCol;
  const checkboxes = document.querySelectorAll('.col-filter-checkbox');
  const allChecked = Array.from(checkboxes).every((cb) => cb.checked);

  if (allChecked) {
    delete activeColumnFilters[colIndex];
  } else {
    const selectedSet = new Set();
    checkboxes.forEach((cb) => {
      if (cb.checked) {
        selectedSet.add(cb.getAttribute('data-val'));
      }
    });
    activeColumnFilters[colIndex] = selectedSet;
  }

  closeColumnFilterPopup();
  applySearchAndSort();
};

window.popupClearFilter = function () {
  if (currentFilterPopupCol >= 0) {
    delete activeColumnFilters[currentFilterPopupCol];
    closeColumnFilterPopup();
    applySearchAndSort();
  }
};

window.clearAllFilters = function () {
  activeColumnFilters = {};
  applySearchAndSort();
};

// 點擊彈窗外部自動關閉
document.addEventListener('click', (e) => {
  const popup = document.getElementById('column-filter-popup');
  if (popup && !popup.classList.contains('hidden') && !popup.contains(e.target)) {
    closeColumnFilterPopup();
  }
});

// 核心：整合搜尋、欄位篩選與智慧排序
function applySearchAndSort() {
  if (!fullTableData) return;
  const searchInput = document.getElementById('search-input');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  // 1. 全域關鍵字搜尋
  let rows = [...fullTableData.rows];
  if (query) {
    rows = rows.filter((row) =>
      row.some((cell) => String(cell).toLowerCase().includes(query))
    );
  }

  // 2. Excel 風格個別欄位多值篩選
  const filterColKeys = Object.keys(activeColumnFilters);
  if (filterColKeys.length > 0) {
    rows = rows.filter((row) => {
      return filterColKeys.every((colIdxStr) => {
        const cIdx = parseInt(colIdxStr, 10);
        const allowedSet = activeColumnFilters[cIdx];
        const cellRaw = row[cIdx] !== null && row[cIdx] !== undefined ? String(row[cIdx]).trim() : '';
        const cellVal = cellRaw === '' ? '(空白)' : cellRaw;
        return allowedSet.has(cellVal);
      });
    });
  }

  // 3. 欄位智慧排序 (數字、金額、日期與繁體中文字串)
  if (currentSortColumn >= 0 && currentSortColumn < fullTableData.headers.length) {
    const col = currentSortColumn;
    const dir = currentSortDirection === 'asc' ? 1 : -1;

    rows.sort((a, b) => {
      const rawA = a[col] !== null && a[col] !== undefined ? String(a[col]).trim() : '';
      const rawB = b[col] !== null && b[col] !== undefined ? String(b[col]).trim() : '';

      if (rawA === '' && rawB !== '') return 1;
      if (rawA !== '' && rawB === '') return -1;
      if (rawA === '' && rawB === '') return 0;

      // 純數字或帶貨幣符號金額比較
      const cleanNumA = rawA.replace(/[$NT,\s%]/g, '');
      const cleanNumB = rawB.replace(/[$NT,\s%]/g, '');
      const isNumA = cleanNumA !== '' && !isNaN(cleanNumA);
      const isNumB = cleanNumB !== '' && !isNaN(cleanNumB);

      if (isNumA && isNumB) {
        return (parseFloat(cleanNumA) - parseFloat(cleanNumB)) * dir;
      }

      // 日期格式比較
      const isDateA = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(rawA);
      const isDateB = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(rawB);
      if (isDateA && isDateB) {
        const dateA = new Date(rawA).getTime();
        const dateB = new Date(rawB).getTime();
        if (!isNaN(dateA) && !isNaN(dateB)) {
          return (dateA - dateB) * dir;
        }
      }

      // 繁體中文與字串語言環境比較
      return rawA.localeCompare(rawB, 'zh-Hant', { numeric: true, sensitivity: 'base' }) * dir;
    });
  }

  filteredRows = rows;
  currentPage = 1;

  renderSortStatusPill();
  renderFilterStatusPill();
  renderTableHeaders();
  renderTableBody();
}

function renderTableBody() {
  const tbody = document.getElementById('table-body');
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = Math.min(startIndex + rowsPerPage, filteredRows.length);
  const currentSlice = filteredRows.slice(startIndex, endIndex);

  if (currentSlice.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="${fullTableData.headers.length + 1}" class="py-12 text-center text-slate-400">
        無符合搜尋條件的資料
      </td></tr>
    `;
    updatePaginationControls(0, 0, 0);
    return;
  }

  let rowsHtml = '';
  currentSlice.forEach((row, rowIdx) => {
    const globalRowNumber = startIndex + rowIdx + 1;
    rowsHtml += `<tr class="hover:bg-indigo-50/40 transition">`;
    rowsHtml += `<td class="py-3 px-4 text-center font-mono text-xs text-slate-400 bg-slate-50/50">${globalRowNumber}</td>`;

    row.forEach((cell) => {
      rowsHtml += `<td class="py-3 px-4 whitespace-nowrap text-slate-700">${escapeHtml(String(cell !== null && cell !== undefined ? cell : ''))}</td>`;
    });

    rowsHtml += `</tr>`;
  });

  tbody.innerHTML = rowsHtml;
  updatePaginationControls(startIndex + 1, endIndex, filteredRows.length);
}

function updatePaginationControls(start, end, total) {
  document.getElementById('pagination-info').textContent =
    total === 0 ? '無資料' : `顯示第 ${start} 至 ${end} 筆，共 ${total} 筆`;

  const totalPages = Math.ceil(total / rowsPerPage) || 1;
  document.getElementById('page-indicator').textContent = `${currentPage} / ${totalPages}`;

  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
}

// 搜尋關鍵字過濾 (同步連動排序)
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', () => {
    applySearchAndSort();
  });
}

// 分頁切換
document.getElementById('btn-prev-page').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderTableBody();
  }
});

document.getElementById('btn-next-page').addEventListener('click', () => {
  const totalPages = Math.ceil(filteredRows.length / rowsPerPage);
  if (currentPage < totalPages) {
    currentPage++;
    renderTableBody();
  }
});

// ==========================================
// 4. 管理員：Excel 上傳 (Excel Upload)
// ==========================================

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const fileChosenText = document.getElementById('file-chosen-text');
const btnUploadSubmit = document.getElementById('btn-upload-submit');
const uploadForm = document.getElementById('upload-form');

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('border-indigo-500', 'bg-indigo-50/50');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('border-indigo-500', 'bg-indigo-50/50');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('border-indigo-500', 'bg-indigo-50/50');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    fileInput.files = e.dataTransfer.files;
    updateFileDisplay();
  }
});

fileInput.addEventListener('change', updateFileDisplay);

function updateFileDisplay() {
  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    fileChosenText.textContent = `已選擇：${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    fileChosenText.classList.add('text-indigo-600', 'font-medium');
    btnUploadSubmit.disabled = false;
  } else {
    fileChosenText.textContent = '尚未選擇任何檔案 (限制 25MB 以內)';
    fileChosenText.classList.remove('text-indigo-600', 'font-medium');
    btnUploadSubmit.disabled = true;
  }
}

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files || !fileInput.files[0]) return;

  const categoryRadio = document.querySelector('input[name="upload-category"]:checked');
  const customTitleInput = document.getElementById('upload-custom-title');

  const formData = new FormData();
  formData.append('excelFile', fileInput.files[0]);
  formData.append('category', categoryRadio ? categoryRadio.value : '條件與階段');
  formData.append('customTitle', customTitleInput ? customTitleInput.value.trim() : '');

  btnUploadSubmit.disabled = true;
  btnUploadSubmit.innerHTML = '<i class="ph ph-spinner animate-spin"></i><span>檔案解析中...</span>';

  try {
    const res = await authFetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();

    if (res.ok) {
      alert('✅ Excel 表格上傳並解析成功！已依分類加入檔案清單。');
      fileInput.value = '';
      if (customTitleInput) customTitleInput.value = '';
      updateFileDisplay();
      
      const newFileId = result.file ? result.file.id : (result.table ? result.table.id : null);
      // 若上傳了特定類別，切換至該分類
      if (result.file && result.file.category) {
        currentCategory = result.file.category;
        switchCategory(currentCategory);
      }

      await loadAvailableFiles(newFileId);
      await loadAdminFileList();

      // 自動跳轉回資料檢視頁
      navBtnData.click();
    } else {
      alert('❌ 上傳失敗：' + (result.error || '未知錯誤'));
    }
  } catch (err) {
    alert('❌ 上傳失敗，無法連接後端：' + err.message);
  } finally {
    btnUploadSubmit.disabled = false;
    btnUploadSubmit.innerHTML = '<i class="ph ph-cloud-arrow-up text-base"></i><span>立即解析並套用資料</span>';
  }
});

// ==========================================
// 5. 管理員：已上傳檔案管理 (File Management)
// ==========================================

async function loadAdminFileList() {
  try {
    const res = await authFetch('/api/files');
    const data = await res.json();
    const tbody = document.getElementById('admin-files-table-body');
    const countBadge = document.getElementById('admin-file-count');

    if (!data.files || data.files.length === 0) {
      if (countBadge) countBadge.textContent = '共 0 個檔案';
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-400">目前尚無已上傳的檔案</td></tr>';
      return;
    }

    if (countBadge) countBadge.textContent = `共 ${data.files.length} 個檔案`;

    let html = '';
    data.files.forEach((f) => {
      const uploadDate = new Date(f.uploadedAt).toLocaleString('zh-TW');
      const isPerf = f.category === '實績表';
      const catBadge = isPerf
        ? '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800">實績表</span>'
        : '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800">條件與階段</span>';

      html += `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-semibold text-slate-800">
            <div class="flex items-center gap-2">
              <i class="ph ph-file-xls text-emerald-600 text-lg shrink-0"></i>
              <span class="truncate max-w-xs" title="${escapeHtml(f.fileName)}">${escapeHtml(f.fileName)}</span>
            </div>
          </td>
          <td class="py-3 px-4">${catBadge}</td>
          <td class="py-3 px-4 text-xs text-slate-500">${escapeHtml(f.sheetName || 'Sheet1')}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded text-xs font-semibold bg-indigo-50 text-indigo-700">${f.totalRows} 筆</span>
          </td>
          <td class="py-3 px-4 text-xs text-slate-600">${escapeHtml(f.uploadedBy || '管理員')}</td>
          <td class="py-3 px-4 text-xs text-slate-400">${uploadDate}</td>
          <td class="py-3 px-4 text-center whitespace-nowrap space-x-2">
            <button onclick="viewFileFromAdmin('${escapeHtml(f.id)}')" class="text-indigo-600 hover:text-indigo-800 text-xs font-semibold px-2 py-1 rounded hover:bg-indigo-50 transition">檢視</button>
            <button onclick="deleteFile('${escapeHtml(f.id)}', '${escapeHtml(f.fileName)}')" class="text-rose-600 hover:text-rose-800 text-xs font-semibold px-2 py-1 rounded hover:bg-rose-50 transition">刪除</button>
          </td>
        </tr>
      `;
    });
    if (tbody) tbody.innerHTML = html;
  } catch (err) {
    console.error('Load admin file list failed:', err);
  }
}

window.viewFileFromAdmin = async function(fileId) {
  const selector = document.getElementById('file-selector');
  if (selector) selector.value = fileId;
  await loadFileById(fileId);
  navBtnData.click();
};

window.deleteFile = async function(fileId, fileName) {
  if (!confirm(`確定要刪除表格檔案「${fileName}」嗎？\n刪除後員工將無法再查閱此表格。`)) {
    return;
  }
  try {
    const res = await authFetch('/api/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert('✅ 檔案已成功刪除！');
      await loadAvailableFiles();
      await loadAdminFileList();
    } else {
      alert('❌ 刪除失敗：' + (data.error || '未知錯誤'));
    }
  } catch (err) {
    alert('❌ 刪除失敗：' + err.message);
  }
};

// ==========================================
// 6. 管理員：帳號管理 (User Management)
// ==========================================

async function loadUsersList() {
  try {
    const res = await authFetch('/api/users');
    const data = await res.json();
    const tbody = document.getElementById('user-table-body');

    if (!data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-slate-400">目前尚無使用者</td></tr>';
      return;
    }

    let rowsHtml = '';
    data.users.forEach((u) => {
      const createdDate = new Date(u.createdAt).toLocaleDateString('zh-TW');
      const isCurrentAdmin = currentUser && currentUser.username === u.username;

      rowsHtml += `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 font-mono font-medium text-slate-800">${escapeHtml(u.username)}</td>
          <td class="py-3 px-4">${escapeHtml(u.displayName)}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded text-xs font-semibold ${
              u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'
            }">
              ${u.role === 'admin' ? '系統管理員' : '一般員工'}
            </span>
          </td>
          <td class="py-3 px-4 text-xs text-slate-400">${createdDate}</td>
          <td class="py-3 px-4 text-center">
            ${
              isCurrentAdmin
                ? '<span class="text-xs text-slate-300">目前登入中</span>'
                : `<button onclick="deleteUser('${escapeHtml(u.username)}')" class="text-rose-600 hover:text-rose-800 text-xs font-medium px-2 py-1 rounded hover:bg-rose-50 transition">刪除</button>`
            }
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml;
  } catch (err) {
    console.error('Load users error:', err);
  }
}

// 批次匯入使用者 Modal 開關
const modalImportUsers = document.getElementById('modal-import-users');
const btnOpenImportUsers = document.getElementById('btn-open-import-users');
const btnCloseImportModal = document.getElementById('btn-close-import-modal');
const btnCancelImportModal = document.getElementById('btn-cancel-import-modal');
const importUsersForm = document.getElementById('import-users-form');
const usersFileInput = document.getElementById('users-file-input');
const btnSubmitImportUsers = document.getElementById('btn-submit-import-users');

if (btnOpenImportUsers) {
  btnOpenImportUsers.addEventListener('click', () => {
    if (usersFileInput) usersFileInput.value = '';
    modalImportUsers.classList.remove('hidden');
  });
}
if (btnCloseImportModal) btnCloseImportModal.addEventListener('click', () => modalImportUsers.classList.add('hidden'));
if (btnCancelImportModal) btnCancelImportModal.addEventListener('click', () => modalImportUsers.classList.add('hidden'));

if (importUsersForm) {
  importUsersForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!usersFileInput.files || !usersFileInput.files[0]) {
      alert('請先選擇要匯入的 Excel 檔案');
      return;
    }

    const formData = new FormData();
    formData.append('usersFile', usersFileInput.files[0]);

    btnSubmitImportUsers.disabled = true;
    btnSubmitImportUsers.innerHTML = '<i class="ph ph-spinner animate-spin"></i><span>匯入解析中...</span>';

    try {
      const res = await authFetch('/api/users/import', {
        method: 'POST',
        body: formData,
      });
      const result = await res.json();

      if (res.ok) {
        alert('🎉 ' + result.message);
        modalImportUsers.classList.add('hidden');
        importUsersForm.reset();
        await loadUsersList();
      } else {
        alert('❌ 匯入失敗：' + (result.error || '未知錯誤'));
      }
    } catch (err) {
      alert('❌ 連線伺服器失敗：' + err.message);
    } finally {
      btnSubmitImportUsers.disabled = false;
      btnSubmitImportUsers.innerHTML = '<i class="ph ph-check"></i><span>開始解析並批次匯入</span>';
    }
  });
}

// 建立使用者 Modal 開關
const modalCreateUser = document.getElementById('modal-create-user');
const btnOpenCreateUser = document.getElementById('btn-open-create-user');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelModal = document.getElementById('btn-cancel-modal');
const createUserForm = document.getElementById('create-user-form');

btnOpenCreateUser.addEventListener('click', () => modalCreateUser.classList.remove('hidden'));
btnCloseModal.addEventListener('click', () => modalCreateUser.classList.add('hidden'));
btnCancelModal.addEventListener('click', () => modalCreateUser.classList.add('hidden'));

createUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('new-username').value;
  const password = document.getElementById('new-password').value;
  const displayName = document.getElementById('new-display-name').value;
  const role = document.getElementById('new-role').value;

  try {
    const res = await authFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName, role }),
    });
    const result = await res.json();

    if (res.ok) {
      alert('✅ 員工帳號建立成功！');
      createUserForm.reset();
      modalCreateUser.classList.add('hidden');
      loadUsersList();
    } else {
      alert('❌ 建立失敗：' + (result.error || '未知原因'));
    }
  } catch (err) {
    alert('❌ 連線錯誤：' + err.message);
  }
});

window.deleteUser = async function (username) {
  if (!confirm(`確定要刪除帳號「${username}」嗎？刪除後該員工將無法再登入。`)) {
    return;
  }
  try {
    const res = await authFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    const result = await res.json();
    if (res.ok) {
      loadUsersList();
    } else {
      alert('刪除失敗：' + result.error);
    }
  } catch (err) {
    alert('刪除失敗：' + err.message);
  }
};

// 工具函式：XSS 轉義
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 頁面載入時檢查登入狀態
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});
