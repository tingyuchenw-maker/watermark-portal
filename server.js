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

// 信任雲端反向代理 (Render / Cloudflare 等 HTTPS 轉發)
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
      fileName: '範例表格.xlsx',
      uploadedAt: new Date().toISOString(),
      uploadedBy: '系統預設',
      sheetName: '人員清冊',
      totalRows: 5,
      headers: ['員工編號', '姓名', '部門', '職稱', '分機號碼', '電子信箱', '狀態'],
      rows: [
        ['EMP-001', '王大明', '技術部', '資深工程師', '8801', 'wang@company.com', '在職'],
        ['EMP-002', '李美麗', '行銷部', '行銷經理', '8802', 'lee@company.com', '在職'],
        ['EMP-003', '陳建國', '財務部', '會計專員', '8803', 'chen@company.com', '在職'],
        ['EMP-004', '林志祥', '人資部', '人資主管', '8804', 'lin@company.com', '在職'],
        ['EMP-005', '趙雅婷', '業務部', '業務專員', '8805', 'chao@company.com', '在職'],
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

// Multer memory storage for Excel files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('僅支援 .xlsx, .xls, .csv 檔案格式'));
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

// 7. Upload Excel (Admin Only, multi-file support)
app.post('/api/upload', requireAdmin, upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '請選取要上傳的 Excel 檔案' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({ error: 'Excel 檔案內無任何工作表' });
    }

    const worksheet = workbook.Sheets[firstSheetName];
    // Convert to 2D array: header row + data rows
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
      fileName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.currentUser.displayName || req.currentUser.username,
      sheetName: firstSheetName,
      totalRows: rows.length,
      headers: headers,
      rows: rows,
    };

    const db = loadDatabase();
    if (!db.files) db.files = [];
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
    res.status(500).json({ error: 'Excel 解析失敗：' + err.message });
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
