require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  MONGO_URI: process.env.MONGO_URI,
  LOG_FILE: process.env.LOG_FILE || null,
  LOCK_TTL_MS: 10 * 60 * 1000,  // 10 min lock TTL
  ALBUM_AGGREGATE_MS: 1000,     // group album photos for 1s
};
