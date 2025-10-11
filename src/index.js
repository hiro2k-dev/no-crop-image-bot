const { BOT_TOKEN } = require('./config');
const { connectMongo } = require('./db');
const { log } = require('./logger');
const { bot } = require('./bot');

(async () => {
  if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is missing. Set it in .env');
    process.exit(1);
  }
  await connectMongo();
  await bot.launch();
  log('info', 'Bot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
