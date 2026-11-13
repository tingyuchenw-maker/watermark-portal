const express = require('express');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');
// const mammoth = require('mammoth'); // 已移除 Word 依賴，改為 PDF
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// 記憶體 Token 快取 (避免登入寫入檔案觸發 Nodemon / Live Server 瀏覽器熱重載)
const activeTokens = {};

const PORT = process.env.PORT || 3000;

// 信任雲端反向代理 (Render / Cloudflare 等 HTTPS 轉發)
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secure-watermark-secret-key-2026',
    resave: true,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 小時
      sameSite: 'lax',
    },
  })
);

// Serve static frontend files (支援放在根目錄或 public 資料夾)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Persistent JSON Storage setup
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const sampleTable = {
      id: 'file_sample_default',
      fileName: '範例條件與階段清冊.xlsx',
      category: '條件與階段',
      uploadedAt: new Date().toISOString(),
      uploadedBy: '系統預設',
      sheetName: '條件與階段',
      totalRows: 5,
      headers: ['項目代碼', '適用階段', '條件說明', '獎勵門檻', '生效狀態', '負責窗口'],
      rows: [
        ['STAGE-01', '第一階段', '個人業績達 30 萬', '基本達成獎金 5,000', '生效中', '業務部-王大明'],
        ['STAGE-02', '第二階段', '累計業績達 60 萬並簽新約', '加碼尊榮豪禮', '進行中', '業務部-李美麗'],
        ['STAGE-03', '第三階段', '爭霸賽全區前三名', '海外旅遊獎勵', '審核中', '業務部-陳建國'],
        ['STAGE-04', '年度特獎', '全年度總績效前 5%', '年終特別紅利', '籌劃中', '人資部-林志祥'],
        ['STAGE-05', '特別激勵', '單月開拓 3 間新客戶', '額外特別津貼', '生效中', '業務部-趙雅婷'],
      ],
    };

    // Initial database template with a default admin and sample employee
    const initialData = {
      tokens: {},
      users: [
        {
          username: 'admin',
          passwordHash: bcrypt.hashSync('admin123', 10),
          displayName: '系統管理員',
          role: 'admin',
          createdAt: new Date().toISOString(),
        },
        {
          username: 'employee01',
          passwordHash: bcrypt.hashSync('pass123', 10),
          displayName: '張小明 (業務部)',
          role: 'viewer',
          createdAt: new Date().toISOString(),
        },
      ],
      files: [sampleTable],
      currentTable: sampleTable,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
    return initialData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!data.tokens) data.tokens = {};
    if (!data.files) {
      data.files = [];
      if (data.currentTable) {
        data.currentTable.id = data.currentTable.id || 'file_legacy';
        data.files.push(data.currentTable);
      }
    }

    if (data.files && Array.isArray(data.files)) {
      data.files.forEach((f) => {
        if (!f.category) f.category = '條件與階段';
        // 自動修復既有被以 Latin1 儲存的亂碼檔名
        if (f.fileName && /[åæçèéêëìíîïñòóôõöùúûü]/i.test(f.fileName)) {
          try {
            const fixed = Buffer.from(f.fileName, 'latin1').toString('utf8');
            if (fixed && !fixed.includes('\ufffd')) {
              f.fileName = fixed;
            }
          } catch (e) {}
        }
      });
    }
    
    return data;
  } catch (err) {
    console.error('Error reading DB file, recreating:', err);
    return { tokens: {}, users: [], files: [], currentTable: null };
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 支援 Session 與 Token 雙重身分驗證 (解決雲端代理與跨域 Cookie 遺失問題)
function getRequestUser(req) {
  if (req.session && req.session.user) {
    return req.session.user;
  }
  const token = req.headers['x-auth-token'] || (req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '').trim() : null);
  if (token) {
    if (activeTokens[token]) {
      return activeTokens[token];
    }
    const db = loadDatabase();
    if (db.tokens && db.tokens[token]) {
      return db.tokens[token];
    }
  }
  return null;
}

// Authentication Middleware
function requireAuth(req, res, next) {
  const user = getRequestUser(req);
  if (!user) {
    return res.status(401).json({ error: '請先登入帳號' });
  }
  req.currentUser = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = getRequestUser(req);
  if (!user) {
    return res.status(401).json({ error: '請先登入帳號' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: '權限不足：需要管理員權限' });
  }
  req.currentUser = user;
  next();
}

// Multer memory storage for Excel and PDF files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv', '.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('僅支援 .xlsx, .xls, .csv, .pdf 檔案格式'));
    }
  },
});

// ======================== API ROUTES ========================

// 1. Current user session check
app.get('/api/me', (req, res) => {
  const user = getRequestUser(req);
  if (!user) {
    return res.json({ loggedIn: false });
  }
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  res.json({
    loggedIn: true,
    user: user,
    clientIp: clientIp.replace('::ffff:', ''),
  });
});

// 2. Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const db = loadDatabase();
  const targetUser = db.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
  if (!targetUser || !bcrypt.compareSync(password, targetUser.passwordHash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  const sessionUser = {
    username: targetUser.username,
    displayName: targetUser.displayName,
    role: targetUser.role,
  };

   // 生成持久化 Token 並儲存
  const token = crypto.randomBytes(24).toString('hex');
  if (!db.tokens) db.tokens = {};
  db.tokens[token] = {
    ...sessionUser,
    createdAt: new Date().toISOString(),
  };
  saveDatabase(db);
  req.session.user = sessionUser;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  res.json({
    message: '登入成功',
    token: token,
    user: sessionUser,
    clientIp: clientIp.replace('::ffff:', ''),
  });
});

// 3. Logout
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    const db = loadDatabase();
    if (db.tokens && db.tokens[token]) {
      delete db.tokens[token];
      saveDatabase(db);
    }
  }
  req.session.destroy(() => {
    res.json({ message: '已成功登出' });
  });
});

// 4. Get All Files List (Metadata only, for selector and management)
app.get('/api/files', requireAuth, (req, res) => {
  const db = loadDatabase();
  const fileSummaries = (db.files || []).map((f) => ({
    id: f.id,
    fileName: f.fileName,
    fileType: f.fileType || 'excel',
    category: f.category || '條件與階段',
    uploadedAt: f.uploadedAt,
    uploadedBy: f.uploadedBy,
    sheetName: f.sheetName,
    totalRows: f.totalRows || (f.rows ? f.rows.length : 0),
  }));
  res.json({ files: fileSummaries });
});

// 5. Get Single File with full data rows
app.get('/api/files/:id', requireAuth, (req, res) => {
  const db = loadDatabase();
  const file = (db.files || []).find((f) => f.id === req.params.id);
  if (!file) {
    return res.status(404).json({ error: '找不到指定的檔案' });
  }
  res.json({ file });
});
// 6. Backward compatible table data
app.get('/api/data', requireAuth, (req, res) => {
  const db = loadDatabase();
  if (db.files && db.files.length > 0) {
    return res.json({ table: db.files[0] });
  }
  if (!db.currentTable) {
    return res.json({ table: null });
  }
  res.json({ table: db.currentTable });
});

// 7. Upload Excel or Word (Admin Only, multi-file & category & UTF-8 filename fix)
app.post('/api/upload', requireAdmin, upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '請選取要上傳的檔案 (Excel 或 Word)' });
    }
    // 🌟 核心修復：解決 Multer 將 UTF-8 中文檔名以 Latin1 (ISO-8859-1) 解析導致的亂碼問題
    let originalName = req.file.originalname;
    try {
      const converted = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      // 驗證轉換後若包含有效繁簡中文字符則採用
      if (converted && !converted.includes('\ufffd')) {
        originalName = converted;
      }
    } catch (e) {
      originalName = req.file.originalname;
    }
    // 取得大分類 (條件與階段 或 實績表) 與 自訂標題
    const rawCategory = (req.body && req.body.category ? req.body.category : '').trim();
    const category = ['條件與階段', '實績表'].includes(rawCategory) ? rawCategory : '條件與階段';
    const customTitle = (req.body && req.body.customTitle ? req.body.customTitle : '').trim();
    const finalFileName = customTitle || originalName;
    const ext = path.extname(originalName).toLowerCase();
    const db = loadDatabase();
    if (!db.files) db.files = [];
    
    // ========== PDF (.pdf) 處理路徑 ==========
    if (ext === '.pdf') {
      const pdfData = req.file.buffer.toString('base64'); // 將 PDF 轉為 Base64 字串

      const newFile = {
        id: 'file_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        fileName: finalFileName,
        originalFileName: originalName,
        fileType: 'pdf',
        category: category,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.currentUser.displayName || req.currentUser.username,
        sheetName: 'PDF 文件',
        totalRows: 0,
        pdfData: pdfData,
      };

      db.files.unshift(newFile);
      db.currentTable = newFile;
      saveDatabase(db);

      // 回傳時不含 pdfData (節省頻寬)
      const { pdfData: _, ...fileSummary } = newFile;
      return res.json({
        message: 'PDF 文件上傳成功！已發布至前台。',
        file: { ...fileSummary, pdfData: pdfData },
        table: fileSummary,
      });
    }

    // ========== Excel / CSV 處理路徑 ==========
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({ error: 'Excel 檔案內無任何工作表' });
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ error: '檔案中沒有任何資料內容' });
    }

    // Filter out completely empty rows
    const cleanedRows = rawData.filter((row) => row.some((cell) => cell !== '' && cell !== null && cell !== undefined));

    if (cleanedRows.length === 0) {
      return res.status(400).json({ error: '工作表內無有效列' });
    }

    const headers = cleanedRows[0].map((h, idx) => (h ? String(h).trim() : `欄位 ${idx + 1}`));
    const rows = cleanedRows.slice(1);

    const newFile = {
      id: 'file_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      fileName: finalFileName,
      originalFileName: originalName,
      fileType: 'excel',
      category: category,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.currentUser.displayName || req.currentUser.username,
      sheetName: firstSheetName,
      totalRows: rows.length,
      headers: headers,
      rows: rows,
    };

    db.files.unshift(newFile); // 最新的檔案排最前
    db.currentTable = newFile;
    saveDatabase(db);

    res.json({
      message: '檔案上傳與解析成功！',
      file: newFile,
      table: newFile,
    });
  } catch (err) {
    console.error('Upload parsing error:', err);
    res.status(500).json({ error: '檔案解析失敗：' + err.message });
  }
});

// 8. Delete File (Admin Only)
app.delete('/api/files/:id', requireAdmin, (req, res) => {
  const db = loadDatabase();
  const fileId = req.params.id;
  if (!db.files) db.files = [];
  
  const initialLength = db.files.length;
  db.files = db.files.filter((f) => f.id !== fileId);

  if (db.files.length === initialLength) {
    return res.status(404).json({ error: '找不到該檔案' });
  }

  if (db.currentTable && db.currentTable.id === fileId) {
    db.currentTable = db.files.length > 0 ? db.files[0] : null;
  }

  saveDatabase(db);
  res.json({ message: '檔案已成功刪除' });
});

// 9. Excel 範本下載 API (提供「條件與階段」、「實績表」與「員工帳號」範本)
app.get('/api/template/:type', (req, res) => {
  const type = req.params.type;

  // 1. 員工帳號批次匯入範本
  if (type === 'users') {
    const headers = ['員工帳號 (必填)', '登入密碼 (必填)', '員工姓名與部門 (選填)', '角色權限 (選填: 一般員工 / 系統管理員)'];
    const sampleRows = [
      ['emp001', 'Pass1234!', '王大明 (業務一部)', '一般員工'],
      ['emp002', 'Pass1234!', '李美麗 (業務二部)', '一般員工'],
      ['emp003', 'Pass1234!', '陳建國 (業務一部)', '一般員工'],
      ['emp004', 'Pass1234!', '林志祥 (人資部)', '一般員工'],
      ['manager01', 'Admin888!', '張協理 (營運管理部)', '系統管理員'],
    ];
    const ws = xlsx.utils.aoa_to_sheet([headers, ...sampleRows]);
    ws['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 32 }];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '員工帳號名單');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('員工帳號匯入_標準範本.xlsx')}"`);
    return res.send(buffer);
  }

  // 2. 業務表格範本
  const isPerformance = type === 'performance';
  const headers = isPerformance
    ? ['統計月份', '業務代號', '業務員姓名', '所屬部門', '目標業績', '實際業績', '達成率', '目前階段', '評核狀態']
    : ['項目代號', '適用階段', '條件門檻說明', '獎勵機制', '開始日期', '截止日期', '主辦窗口', '備註說明'];

  const sampleRows = isPerformance
    ? [
        ['2026-10', 'EMP-001', '王大明', '業務一部', 500000, 580000, '116.0%', '第三階段', '已達標'],
        ['2026-10', 'EMP-002', '李美麗', '業務二部', 400000, 395000, '98.8%', '第二階段', '衝刺中'],
        ['2026-10', 'EMP-003', '陳建國', '業務一部', 600000, 720000, '120.0%', '超越目標', '榮譽達標'],
        ['2026-10', 'EMP-004', '林志祥', '業務三部', 450000, 480000, '106.7%', '第二階段', '已達標'],
        ['2026-10', 'EMP-005', '趙雅婷', '業務一部', 550000, 610000, '110.9%', '第三階段', '已達標'],
      ]
    : [
        ['STAGE-01', '第一階段', '個人累計業績達 30 萬以上', '發給基本達標獎金 $5,000', '2026-10-01', '2026-10-31', '林主管', '已生效'],
        ['STAGE-02', '第二階段', '個人累計業績達 60 萬且簽約新客戶 2 家', '加碼尊榮豪禮 $15,000', '2026-11-01', '2026-11-30', '林主管', '進行中'],
        ['STAGE-03', '第三階段', '冬季豪禮爭霸賽全區前 3 名', '全額海外尊榮旅遊考察', '2026-12-01', '2026-12-31', '管委會', '審核中'],
      ];

  const ws = xlsx.utils.aoa_to_sheet([headers, ...sampleRows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, isPerformance ? '實績表' : '條件與階段');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const downloadFileName = isPerformance ? '實績表_標準範本.xlsx' : '條件與階段_標準範本.xlsx';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFileName)}"`);
  res.send(buffer);
});

// 6. User Management: Get list (Admin Only)
app.get('/api/users', requireAdmin, (req, res) => {
  const db = loadDatabase();
  const safeUsers = db.users.map(({ username, displayName, role, createdAt }) => ({
    username,
    displayName,
    role,
    createdAt,
  }));
  res.json({ users: safeUsers });
});
// 7. User Management: Add user (Admin Only)
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '帳號與密碼為必填' });
  }
  const db = loadDatabase();
  if (db.users.some((u) => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(400).json({ error: '此帳號已存在' });
  }
  
    const newUser = {
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    displayName: (displayName || username).trim(),
    role: role === 'admin' ? 'admin' : 'viewer',
    createdAt: new Date().toISOString(),
  };
  db.users.push(newUser);
  saveDatabase(db);
  res.json({ message: '帳號新增成功', user: { username: newUser.username, displayName: newUser.displayName, role: newUser.role } });
});

// 8. User Management: Batch Import from Excel (Admin Only)
app.post('/api/users/import', requireAdmin, upload.single('usersFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '請選取要匯入的員工名單 Excel 檔案' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({ error: 'Excel 內無有效工作表' });
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!rawData || rawData.length < 2) {
      return res.status(400).json({ error: '表格內無資料列 (至少需包含表頭與一筆資料)' });
    }

    // 取得表頭
    const headers = rawData[0].map((h) => String(h || '').trim());
    
    // 智慧尋找欄位索引
    let uCol = headers.findIndex((h) => /帳號|user|account|工號/i.test(h));
    let pCol = headers.findIndex((h) => /密碼|pass/i.test(h));
    let nCol = headers.findIndex((h) => /姓名|名稱|name|部門/i.test(h));
    let rCol = headers.findIndex((h) => /角色|權限|role/i.test(h));

    // 若未精確匹配表頭，使用預設前四欄順序
    if (uCol === -1) uCol = 0;
    if (pCol === -1) pCol = 1;
    if (nCol === -1) nCol = 2;
    if (rCol === -1) rCol = 3;

    const db = loadDatabase();
    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    const dataRows = rawData.slice(1);
    for (const row of dataRows) {
      const username = String(row[uCol] || '').trim();
      const password = String(row[pCol] || '').trim();
      const displayName = String(row[nCol] || '').trim() || username;
      const roleRaw = String(row[rCol] || '').trim().toLowerCase();
      const role = /admin|管理/i.test(roleRaw) ? 'admin' : 'viewer';

      if (!username || !password) {
        skippedCount++;
        continue;
      }

      const existingIndex = db.users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
      const passwordHash = bcrypt.hashSync(password, 10);

      if (existingIndex !== -1) {
        db.users[existingIndex].passwordHash = passwordHash;
        db.users[existingIndex].displayName = displayName;
        db.users[existingIndex].role = role;
        updatedCount++;
      } else {
        db.users.push({
          username: username,
          passwordHash: passwordHash,
          displayName: displayName,
          role: role,
          createdAt: new Date().toISOString(),
        });
        addedCount++;
      }
    }

    saveDatabase(db);

    res.json({
      message: `匯入成功！已新增 ${addedCount} 位員工帳號，更新 ${updatedCount} 位既有帳號${skippedCount > 0 ? ` (略過 ${skippedCount} 筆無效資料)` : ''}。`,
      total: dataRows.length,
      added: addedCount,
      updated: updatedCount,
      skipped: skippedCount,
    });
  } catch (err) {
    console.error('Batch import error:', err);
    res.status(500).json({ error: '名單解析匯入失敗：' + err.message });
  }
});

// 8. User Management: Delete user (Admin Only)
app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const targetUsername = req.params.username;
  if (targetUsername === req.currentUser.username) {
    return res.status(400).json({ error: '無法刪除自己正在登入的帳號' });
  }
  const db = loadDatabase();
  const initialLength = db.users.length;
  db.users = db.users.filter((u) => u.username !== targetUsername);
  if (db.users.length === initialLength) {
    return res.status(404).json({ error: '找不到該帳號' });
  }
  saveDatabase(db);
  res.json({ message: '帳號已成功刪除' });
});
// Start server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` 🚀 防外洩 Excel 浮水印系統已啟動！`);
  console.log(` 網址: http://localhost:${PORT}`);
  console.log(` 預設管理員: admin / 密碼: admin123`);
  console.log(` 預設員工: employee01 / 密碼: pass123`);
  console.log(`====================================================`);
});
