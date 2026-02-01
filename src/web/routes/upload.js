const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { log } = require('../../logger');

// Chunk upload directory
const UPLOAD_DIR = path.join(__dirname, '../../..', 'uploads');
const CHUNKS_DIR = path.join(UPLOAD_DIR, 'chunks');
const TEMP_DIR = path.join(UPLOAD_DIR, 'temp');

// Ensure directories exist
(async () => {
  await fs.mkdir(CHUNKS_DIR, { recursive: true });
  await fs.mkdir(TEMP_DIR, { recursive: true });
})();

// Multer config for chunk uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadId = req.body.uploadId;
    if (!uploadId) {
      return cb(new Error('uploadId is required'));
    }
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    await fs.mkdir(chunkDir, { recursive: true });
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    const chunkIndex = req.body.chunkIndex;
    cb(null, `chunk-${chunkIndex}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per chunk
  },
});

// POST /api/upload/init - Initialize chunked upload
router.post('/init', async (req, res) => {
  try {
    const { filename, totalChunks, fileSize } = req.body;

    if (!filename || !totalChunks || !fileSize) {
      return res.status(400).json({
        error: 'Missing required fields: filename, totalChunks, fileSize',
      });
    }

    // Security: Validate filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      log('warn', 'Invalid filename with path traversal attempt', { filename });
      return res.status(400).json({
        error: 'Invalid filename: path traversal not allowed',
      });
    }

    // Security: Sanitize filename - only allow safe characters
    const safeFilenameRegex = /^[a-zA-Z0-9_\-\.\s]+$/;
    if (!safeFilenameRegex.test(filename)) {
      log('warn', 'Unsafe filename pattern', { filename });
      return res.status(400).json({
        error: 'Invalid filename: only letters, numbers, dash, underscore, dot and space allowed',
      });
    }

    // Validate file type
    const ext = path.extname(filename).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return res.status(400).json({
        error: 'Only JPEG and PNG images are supported',
      });
    }

    // Security: Validate file size (max 500MB)
    const maxFileSize = 500 * 1024 * 1024; // 500MB
    if (fileSize > maxFileSize) {
      return res.status(400).json({
        error: `File too large. Maximum size: ${maxFileSize / 1024 / 1024}MB`,
      });
    }

    // Security: Validate totalChunks (reasonable limit)
    if (totalChunks < 1 || totalChunks > 1000) {
      return res.status(400).json({
        error: 'Invalid totalChunks: must be between 1 and 1000',
      });
    }

    // Generate unique upload ID
    const uploadId = crypto.randomBytes(16).toString('hex');
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    await fs.mkdir(chunkDir, { recursive: true });

    // Store upload metadata
    const metadata = {
      uploadId,
      filename: path.basename(filename), // Use basename for extra safety
      totalChunks: parseInt(totalChunks),
      fileSize: parseInt(fileSize),
      createdAt: new Date().toISOString(),
      chunks: [],
    };

    await fs.writeFile(
      path.join(chunkDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    log('info', 'Upload initialized', { uploadId, filename, totalChunks, fileSize });

    res.json({
      uploadId,
      message: 'Upload initialized',
    });
  } catch (err) {
    log('error', 'Upload init error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload/chunk - Upload a single chunk
router.post('/chunk', upload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks } = req.body;

    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId, chunkIndex, totalChunks',
      });
    }

    // Security: Validate uploadId format (should be hex from crypto.randomBytes)
    if (!/^[a-f0-9]{32}$/.test(uploadId)) {
      log('warn', 'Invalid uploadId format', { uploadId });
      return res.status(400).json({
        error: 'Invalid uploadId format',
      });
    }

    // Security: Validate chunkIndex
    const idx = parseInt(chunkIndex);
    if (isNaN(idx) || idx < 0 || idx >= parseInt(totalChunks)) {
      return res.status(400).json({
        error: 'Invalid chunkIndex',
      });
    }

    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    
    // Security: Verify chunkDir is inside CHUNKS_DIR
    const resolvedChunkDir = path.resolve(chunkDir);
    const resolvedChunksDir = path.resolve(CHUNKS_DIR);
    if (!resolvedChunkDir.startsWith(resolvedChunksDir)) {
      log('error', 'Path traversal attempt in chunk upload', { uploadId });
      return res.status(403).json({
        error: 'Access denied',
      });
    }

    const metadataPath = path.join(chunkDir, 'metadata.json');

    // Read and update metadata
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    metadata.chunks.push({
      index: parseInt(chunkIndex),
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
    });

    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    log('info', 'Chunk uploaded', {
      uploadId,
      chunkIndex,
      size: req.file.size,
      progress: `${metadata.chunks.length}/${totalChunks}`,
    });

    res.json({
      message: 'Chunk uploaded',
      chunkIndex: parseInt(chunkIndex),
      received: metadata.chunks.length,
      total: parseInt(totalChunks),
    });
  } catch (err) {
    log('error', 'Chunk upload error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload/complete - Merge all chunks
router.post('/complete', async (req, res) => {
  try {
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId is required' });
    }

    // Security: Validate uploadId format
    if (!/^[a-f0-9]{32}$/.test(uploadId)) {
      log('warn', 'Invalid uploadId format in complete', { uploadId });
      return res.status(400).json({
        error: 'Invalid uploadId format',
      });
    }

    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    
    // Security: Verify path
    const resolvedChunkDir = path.resolve(chunkDir);
    const resolvedChunksDir = path.resolve(CHUNKS_DIR);
    if (!resolvedChunkDir.startsWith(resolvedChunksDir)) {
      log('error', 'Path traversal attempt in complete', { uploadId });
      return res.status(403).json({
        error: 'Access denied',
      });
    }

    const metadataPath = path.join(chunkDir, 'metadata.json');

    // Read metadata
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

    // Verify all chunks received
    if (metadata.chunks.length !== metadata.totalChunks) {
      return res.status(400).json({
        error: 'Not all chunks received',
        received: metadata.chunks.length,
        expected: metadata.totalChunks,
      });
    }

    // Sort chunks by index
    const sortedChunks = metadata.chunks.sort((a, b) => a.index - b.index);

    // Merge chunks
    const outputPath = path.join(TEMP_DIR, `${uploadId}_${metadata.filename}`);
    const writeStream = require('fs').createWriteStream(outputPath);

    for (const chunk of sortedChunks) {
      const chunkPath = path.join(chunkDir, `chunk-${chunk.index}`);
      const chunkBuffer = await fs.readFile(chunkPath);
      writeStream.write(chunkBuffer);
    }

    writeStream.end();

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Clean up chunks
    await fs.rm(chunkDir, { recursive: true, force: true });

    log('info', 'Upload completed and merged', {
      uploadId,
      filename: metadata.filename,
      outputPath,
    });

    res.json({
      message: 'Upload completed',
      uploadId,
      filename: metadata.filename,
      filePath: outputPath,
    });
  } catch (err) {
    log('error', 'Upload complete error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/upload/:uploadId - Cancel upload and cleanup
router.delete('/:uploadId', async (req, res) => {
  try {
    const { uploadId } = req.params;
    
    // Security: Validate uploadId format
    if (!/^[a-f0-9]{32}$/.test(uploadId)) {
      log('warn', 'Invalid uploadId format in delete', { uploadId });
      return res.status(400).json({
        error: 'Invalid uploadId format',
      });
    }
    
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    
    // Security: Verify path
    const resolvedChunkDir = path.resolve(chunkDir);
    const resolvedChunksDir = path.resolve(CHUNKS_DIR);
    if (!resolvedChunkDir.startsWith(resolvedChunksDir)) {
      log('error', 'Path traversal attempt in delete', { uploadId });
      return res.status(403).json({
        error: 'Access denied',
      });
    }

    await fs.rm(chunkDir, { recursive: true, force: true });

    log('info', 'Upload cancelled', { uploadId });

    res.json({ message: 'Upload cancelled and cleaned up' });
  } catch (err) {
    log('error', 'Upload cancel error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
