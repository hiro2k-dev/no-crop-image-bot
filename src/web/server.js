const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectMongo } = require('../db');
const { log } = require('../logger');
const uploadRoutes = require('./routes/upload');
const processRoutes = require('./routes/process');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (for FE later)
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/upload', uploadRoutes);
app.use('/api/process', processRoutes);

// Error handler
app.use((err, req, res, next) => {
  log('error', 'Express error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Start server
async function start() {
  try {
    await connectMongo();
    app.listen(PORT, () => {
      log('info', `Web server started on port ${PORT}`);
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
