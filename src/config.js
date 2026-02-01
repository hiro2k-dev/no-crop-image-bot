require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  TELEGRAM_API_BASE: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  CORS_ORIGINS: process.env.CORS_ORIGINS 
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : null,
  DOWNLOAD_EXPIRY_HOURS: process.env.DOWNLOAD_EXPIRY_HOURS 
    ? parseInt(process.env.DOWNLOAD_EXPIRY_HOURS, 10) 
    : 24, 
  MONGO_URI: process.env.MONGO_URI,
  LOG_FILE: process.env.LOG_FILE || null,
  LOCK_TTL_MS: 10 * 60 * 1000,
  ALBUM_AGGREGATE_MS: 1000,
  KEEP_BYTES_APPROX: process.env.KEEP_BYTES_APPROX === '1',
  KEEP_BYTES_TOL: Number(process.env.KEEP_BYTES_TOL || 0.15),
};
