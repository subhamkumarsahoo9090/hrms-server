const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadsDir = path.join(__dirname, '..', 'uploads', 'chat');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const ALLOWED_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.md',
  '.csv',
  '.zip',
  '.rar',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.cs',
  '.sql',
]);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    const safeExt = ALLOWED_EXT.has(ext) ? ext : '.bin';
    const emp = String(req.user?.employeeId || 'user').replace(/[^\w-]/g, '');
    cb(null, `${emp}-${Date.now()}${safeExt}`);
  },
});

const uploadChat = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '');
    const okMime =
      mime.startsWith('image/') ||
      mime.startsWith('text/') ||
      mime === 'application/pdf' ||
      mime.includes('officedocument') ||
      mime.includes('msword') ||
      mime.includes('excel') ||
      mime.includes('powerpoint') ||
      mime.includes('zip') ||
      mime === 'application/json' ||
      mime === 'application/octet-stream';
    if (ALLOWED_EXT.has(ext) || okMime) {
      cb(null, true);
      return;
    }
    cb(new Error('File type not allowed for chat'));
  },
});

module.exports = { uploadChat, uploadsDir, ALLOWED_EXT };
