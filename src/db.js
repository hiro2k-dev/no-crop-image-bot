const mongoose = require('mongoose');
const { MONGO_URI } = require('./config');
const { log } = require('./logger');

async function connectMongo() {
  if (!MONGO_URI) {
    log('warn', 'MONGO_URI not set; database features disabled');
    return null;
  }
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  log('info', 'Mongo connected', { uri: MONGO_URI.replace(/\/\/.*@/, '//***:***@') });
  return mongoose.connection;
}

module.exports = { connectMongo, mongoose };
