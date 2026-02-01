const mongoose = require('mongoose');
const { MONGO_URI } = require('./config');
const { log } = require('./logger');

async function connectMongo() {
  if (!MONGO_URI) {
    log('warn', 'MONGO_URI not set; database features disabled');
    return null;
  }
  
  try {
    await mongoose.connect(MONGO_URI, {
      autoIndex: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    log('info', 'Mongo connected', { uri: MONGO_URI.replace(/\/\/.*@/, '//***:***@') });
    return mongoose.connection;
  } catch (err) {
    log('warn', 'Mongo connection failed; database features disabled', { error: err.message });
    console.warn('[WARNING] MongoDB connection failed:', err.message);
    console.warn('   Continuing without database...\n');
    return null;
  }
}

module.exports = { connectMongo, mongoose };
