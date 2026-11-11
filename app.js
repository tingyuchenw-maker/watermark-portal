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

  // 載入表格資料
  loadTableData();

  if (currentUser.role === 'admin') {
    loadUsersList();
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
});

// ==========================================
// 3. 表格載入、搜尋與分頁 (Table & Search)
// ==========================================

async function loadTableData() {
  try {
    const res = await authFetch('/api/data');
    const data = await res.json();
    if (data.table) {
      fullTableData = data.table;
      filteredRows = [...fullTableData.rows];
      currentPage = 1;
      renderTableMeta();
      renderTableHeaders();
      renderTableBody();
    } else {
      document.getElementById('table-filename').textContent = '目前尚未有上傳的表格';
      document.getElementById('table-body').innerHTML = `
        <tr><td colspan="10" class="py-12 text-center text-slate-400">目前後台尚未發布任何資料</td></tr>
      `;
    }
  } catch (err) {
    console.error('Load table failed:', err);
  }
}

function renderTableMeta() {
  document.getElementById('table-filename').textContent = fullTableData.fileName;
  document.getElementById('table-total-badge').textContent = `${fullTableData.rows.length} 筆資料`;
  const uploadDate = new Date(fullTableData.uploadedAt).toLocaleString('zh-TW');
  document.getElementById('table-meta-info').textContent =
    `更新時間: ${uploadDate} | 發布人員: ${fullTableData.uploadedBy}`;
}

function renderTableHeaders() {
  const thead = document.getElementById('table-head');
  let headerHtml = '<tr><th class="py-3.5 px-4 text-center w-14 bg-slate-100 font-bold text-slate-700">#</th>';

  fullTableData.headers.forEach((headerText) => {
    headerHtml += `<th class="py-3.5 px-4 font-semibold text-slate-700 whitespace-nowrap">${escapeHtml(headerText)}</th>`;
  });

  headerHtml += '</tr>';
  thead.innerHTML = headerHtml;
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

// 搜尋關鍵字過濾
const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim().toLowerCase();
  if (!fullTableData) return;

  if (!query) {
    filteredRows = [...fullTableData.rows];
  } else {
    filteredRows = fullTableData.rows.filter((row) =>
      row.some((cell) => String(cell).toLowerCase().includes(query))
    );
  }

  currentPage = 1;
  renderTableBody();
});

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

  const formData = new FormData();
  formData.append('excelFile', fileInput.files[0]);

  btnUploadSubmit.disabled = true;
  btnUploadSubmit.innerHTML = '<i class="ph ph-spinner animate-spin"></i><span>檔案解析中...</span>';

  try {
    const res = await authFetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const result = await res.json();

    if (res.ok) {
      alert('✅ Excel 表格上傳並解析成功！已更新至前台資料檢視。');
      fullTableData = result.table;
      filteredRows = [...fullTableData.rows];
      currentPage = 1;
      renderTableMeta();
      renderTableHeaders();
      renderTableBody();

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
// 5. 管理員：帳號管理 (User Management)
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
