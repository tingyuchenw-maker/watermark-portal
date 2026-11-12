const express = require('express');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secure-watermark-secret-key-2026',
    resave: true,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, 
      sameSite: 'lax',
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

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
    return data;
  } catch (err) {
    console.error('Error reading DB file, recreating:', err);
    return { tokens: {}, users: [], files: [], currentTable: null };
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getRequestUser(req) {
  if (req.session && req.session.user) {
    return req.session.user;
  }
  const token = req.headers['x-auth-token'] || (req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '').trim() : null);
  if (token) {
    const db = loadDatabase();
    if (db.tokens && db.tokens[token]) {
      return db.tokens[token];
    }
  }
  return null;
}

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, 
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

app.get('/api/files/:id', requireAuth, (req, res) => {
  const db = loadDatabase();
  const file = (db.files || []).find((f) => f.id === req.params.id);
  if (!file) {
    return res.status(404).json({ error: '找不到指定的檔案' });
  }
  res.json({ file });
});

// 🌟 5b. 取得加密原始 PDF 資料流以供前端高精確度解析渲染
app.get('/api/files/:id/raw', requireAuth, (req, res) => {
  const db = loadDatabase();
  const file = (db.files || []).find((f) => f.id === req.params.id);
  if (!file) {
    return res.status(404).json({ error: '找不到指定的檔案' });
  }
  if (file.fileType === 'pdf' && file.base64Data) {
    const buffer = Buffer.from(file.base64Data, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}.pdf"`);
    return res.send(buffer);
  }
  res.status(400).json({ error: '此檔案不支援原始 PDF 讀取' });
});

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

app.post('/api/upload', requireAdmin, upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '請選取要上傳的檔案 (Excel 或 PDF)' });
    }

    let originalName = req.file.originalname;
    try {
      const converted = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      if (converted && !converted.includes('\ufffd')) {
        originalName = converted;
      }
    } catch (e) {
      originalName = req.file.originalname;
    }

    const rawCategory = (req.body && req.body.category ? req.body.category : '').trim();
    const category = ['條件與階段', '實績表'].includes(rawCategory) ? rawCategory : '條件與階段';
    const customTitle = (req.body && req.body.customTitle ? req.body.customTitle : '').trim();
    const finalFileName = customTitle || originalName;

    const ext = path.extname(originalName).toLowerCase();
    const db = loadDatabase();
    if (!db.files) db.files = [];

    // ========== PDF 處理路徑 ==========
    if (ext === '.pdf') {
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
        base64Data: req.file.buffer.toString('base64'), // 儲存供前端渲染之 Base64 檔案
      };

      db.files.unshift(newFile);
      db.currentTable = newFile;
      saveDatabase(db);

      const { base64Data: _, ...fileSummary } = newFile;
      return res.json({
        message: 'PDF 文件上傳成功！已發布至前台。',
        file: fileSummary,
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

    db.files.unshift(newFile); 
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

app.get('/api/template/:type', (req, res) => {
  const type = req.params.type;

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
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('員工帳號匯入_標準範本.x
