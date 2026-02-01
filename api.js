#!/usr/bin/env node

/**
 * Web API Server Entry Point
 * Run: node api.js or npm run api
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { PORT, CORS_ORIGINS } = require('./src/config');
const { connectMongo } = require('./src/db');
const { log } = require('./src/logger');
const uploadRoutes = require('./src/web/routes/upload');
const processRoutes = require('./src/web/routes/process');
const layoutRoutes = require('./src/web/routes/layout');

const app = express();
const port = PORT || 3000;

// CORS Configuration
const defaultOrigins = [
  'http://localhost:5173',  // Vite dev server
  'http://localhost:3000',  // React dev server
  'http://localhost:8080',  // Alternative dev port
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

const corsOptions = {
  origin: CORS_ORIGINS || defaultOrigins,
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (for FE later)
const publicDir = path.join(__dirname, 'src/web/public');
app.use(express.static(publicDir));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'no-crop-image-api'
  });
});

// API Routes
app.use('/api/upload', uploadRoutes);
app.use('/api/process', processRoutes);
app.use('/api/layout', layoutRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  log('error', 'Express error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Start server
async function start() {
  console.log('Starting Web API Server...\n');

  try {
    // MongoDB is optional for API
    await connectMongo();
    
    app.listen(port, () => {
      log('info', `Web API server started on port ${port}`);
      console.log('Web API Server is running!');
      console.log(`   URL: http://localhost:${port}`);
      console.log(`   Health: http://localhost:${port}/health`);
      console.log(`   CORS: ${(CORS_ORIGINS || defaultOrigins).join(', ')}`);
      console.log(`   API Docs: See API_DOCS.md`);
      console.log('   Press Ctrl+C to stop\n');
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    log('error', 'Server startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nStopping server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nStopping server...');
  process.exit(0);
});

if (require.main === module) {
  start();
}

module.exports = { app };
