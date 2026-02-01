#!/usr/bin/env node

const { BOT_TOKEN } = require('./src/config');
const { connectMongo } = require('./src/db');
const { log } = require('./src/logger');
const { bot } = require('./src/bot');

(async () => {
  console.log('Starting Telegram Bot...\n');

  if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is missing. Set it in .env file');
    console.error('   Example: BOT_TOKEN=your_telegram_bot_token\n');
    process.exit(1);
  }

  try {
    await connectMongo();
    await bot.launch();
    
    log('info', 'Telegram bot started successfully');
    console.log('Telegram Bot is running!');
    console.log('   Press Ctrl+C to stop\n');
  } catch (err) {
    console.error('Failed to start bot:', err.message);
    log('error', 'Bot startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();

process.once('SIGINT', () => {
  console.log('\nStopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('\nStopping bot...');
  bot.stop('SIGTERM');
});
