// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Removed mammoth as we are using PDF now

// 資料庫模擬 (db.json)
const DB_FILE = path.join(__dirname, 'db.json');
function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDb = {
      users: [
        {
          username: 'admin',
          displayName: '系統管理員',
          role: 'admin',
          passwordHash: bcrypt.hashSync('admin123', 10),
        },
        {
          username: 'user',
          displayName: '測試人員',
          role: 'user',
          passwordHash: bcrypt.hashSync('pass123', 10),
        }
      ],
      files: [],
      currentTable: null
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf-8');
    return initialDb;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDatabase(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

let db = loadDatabase();

// JWT 密鑰
const JWT_SECRET = 'your-secret-key-for-jwt-token';

// 靜態檔案路徑
app.use(express.static(path.join(__dirname)));

// 認證中間件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未授權存取，請先登入' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '認證逾期或無效，請重新登入' });
    req.currentUser = user;
    next();
  });
}

// 權限檢查中間件
function requireAdmin(req, res, next) {
  if (req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: '此操作需要管理員權限' });
  }
  next();
}

// Multer memory storage for Excel and PDF files
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 限制 25MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv', '.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('僅支援 .xlsx, .xls, .csv, .pdf 檔案格式'));
    }
  }
});

// 2. 登入路由
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }

  const targetUser = db.users.find(u => u.username === username);
  if (!targetUser || !bcrypt.compareSync(password, targetUser.passwordHash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const token = jwt.sign(
    { username: targetUser.username, displayName: targetUser.displayName, role: targetUser.role },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    user: {
      username: targetUser.username,
      displayName: targetUser.displayName,
      role: targetUser.role
    }
  });
});

// 7. Upload Excel or PDF (Admin Only)
app.post('/api/upload', authenticateToken, requireAdmin, upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '請選取要上傳的檔案 (Excel 或 PDF)' });
    }

    const originalName = Buffer.from(req.file.originalname, 'binary').toString('utf8');
    const customTitle = req.body.customTitle ? req.body.customTitle.trim() : '';
    const category = req.body.category || '條件與階段';
    const ext = path.extname(originalName).toLowerCase();

    // 決定最終檔名
    const finalFileName = customTitle ? (customTitle + ext) : originalName;

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

    // ========== Excel 處理路徑 (維持原有 logic) ==========
    const xlsx = require('xlsx');
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // 解析為二維陣列
    const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: null });
    if (rawData.length === 0) {
      return res.status(400).json({ error: 'Excel 檔案內無任何資料' });
    }

    // 分離標頭檔與資料行
    const headers = rawData[0].map(h => h === null ? '' : String(h).trim());
    const rows = rawData.slice(1).map(row => {
      const paddedRow = Array(headers.length).fill(null);
      for (let i = 0; i < headers.length; i++) {
        paddedRow[i] = row[i] !== undefined ? row[i] : null;
      }
      return paddedRow;
    });

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
      rows: rows
    };

    db.files.unshift(newFile);
    db.currentTable = newFile;
    saveDatabase(db);

    const { rows: _, ...fileSummary } = newFile;
    res.json({
      message: 'Excel 表格解析成功！已儲存並發布。',
      file: fileSummary,
      table: fileSummary
    });

  } catch (error) {
    console.error('Upload process failed:', error);
    res.status(500).json({ error: '伺服器解析上傳檔案失敗，請再試一次。' });
  }
});

// 獲取所有檔案清單 (排除內容，僅留 metadata)
app.get('/api/files', authenticateToken, (req, res) => {
  const summaries = db.files.map(f => {
    const { rows, htmlContent, pdfData, ...summary } = f;
    return summary;
  });
  res.json({ files: summaries });
});

// 依據 ID 獲取特定檔案詳細資訊 (包含內容)
app.get('/api/files/:id', authenticateToken, (req, res) => {
  const file = db.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: '找不到指定的檔案' });
  res.json({ file });
});

// 刪除檔案 (Admin Only)
app.delete('/api/files/:id', authenticateToken, requireAdmin, (req, res) => {
  const index = db.files.findIndex(f => f.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: '找不到指定的檔案' });

  db.files.splice(index, 1);
  if (db.currentTable && db.currentTable.id === req.params.id) {
    db.currentTable = db.files.length > 0 ? db.files[0] : null;
  }
  saveDatabase(db);
  res.json({ message: '檔案刪除成功' });
});

// 使用者帳號管理與匯入路由 (維持原系統)...
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
  const userSummaries = db.users.map(u => ({ username: u.username, displayName: u.displayName, role: u.role }));
  res.json({ users: userSummaries });
});

app.post('/api/users', authenticateToken, requireAdmin, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '使用者名稱與密碼不可為空' });
  }
  if (db.users.some(u => u.username === username)) {
    return res.status(400).json({ error: '使用者名稱已存在' });
  }

  const newUser = {
    username,
    displayName: displayName || username,
    role: role || 'user',
    passwordHash: bcrypt.hashSync(password, 10),
  };
  db.users.push(newUser);
  saveDatabase(db);
  res.json({ message: '使用者建立成功', user: { username: newUser.username, displayName: newUser.displayName, role: newUser.role } });
});

app.post('/api/users/import', authenticateToken, requireAdmin, upload.single('excelFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選取匯入檔案' });
    const xlsx = require('xlsx');
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const list = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let importedCount = 0;
    list.forEach(row => {
      const keys = Object.keys(row);
      const uCol = keys.find(k => k.toLowerCase().includes('user') || k.includes('帳號'));
      const nCol = keys.find(k => k.toLowerCase().includes('name') || k.includes('姓名') || k.includes('顯示名稱'));
      const pCol = keys.find(k => k.toLowerCase().includes('pass') || k.includes('密碼'));
      const rCol = keys.find(k => k.toLowerCase().includes('role') || k.includes('權限'));

      if (!uCol) return;
      const username = String(row[uCol] || '').trim();
      const displayName = nCol ? String(row[nCol] || '').trim() : username;
      const password = String(row[pCol] || '').trim();
      const role = rCol ? String(row[rCol] || '').trim() : 'user';

      if (!username || !password) return;

      const passwordHash = bcrypt.hashSync(password, 10);
      const existingIndex = db.users.findIndex(u => u.username === username);
      if (existingIndex !== -1) {
        db.users[existingIndex].displayName = displayName;
        db.users[existingIndex].passwordHash = passwordHash;
        db.users[existingIndex].role = role;
      } else {
        db.users.push({
          username,
          displayName,
          passwordHash,
          role
        });
      }
      importedCount++;
    });

    saveDatabase(db);
    res.json({ message: `成功解析並匯入 ${importedCount} 個使用者帳號！` });
  } catch (err) {
    res.status(500).json({ error: '使用者帳號批次匯入失敗' });
  }
});

app.delete('/api/users/:username', authenticateToken, requireAdmin, (req, res) => {
  if (req.params.username === 'admin') {
    return res.status(400).json({ error: '預設系統管理員帳號無法刪除' });
  }
  const idx = db.users.findIndex(u => u.username === req.params.username);
  if (idx === -1) return res.status(404).json({ error: '找不到該使用者' });

  db.users.splice(idx, 1);
  saveDatabase(db);
  res.json({ message: '使用者帳號已刪除' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
