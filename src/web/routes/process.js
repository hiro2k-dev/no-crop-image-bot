const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { log, genTraceId } = require('../../logger');
const { noCropBuffer, mapFormatToExt } = require('../../image');
const { parseRatio, parseColor } = require('../../state');
const { DOWNLOAD_EXPIRY_HOURS } = require('../../config');
const ProcessedFile = require('../../models/ProcessedFile');

const TEMP_DIR = path.join(__dirname, '../../../uploads/temp');
const OUTPUT_DIR = path.join(__dirname, '../../../uploads/output');

// Ensure output directory exists
(async () => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
})();

// POST /api/process - Process uploaded image
router.post('/', async (req, res) => {
  const traceId = genTraceId();
  
  try {
    const { uploadId, filename, ratio: ratioStr, color: colorStr } = req.body;

    if (!uploadId || !filename) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId, filename',
      });
    }

    // Security: Validate uploadId format (32 char hex)
    if (!/^[a-f0-9]{32}$/.test(uploadId)) {
      log('warn', 'Invalid uploadId format in process', { uploadId, traceId });
      return res.status(400).json({
        error: 'Invalid uploadId format',
      });
    }

    // Security: Validate filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      log('warn', 'Path traversal attempt in filename', { filename, traceId });
      return res.status(400).json({
        error: 'Invalid filename',
      });
    }

    // Security: Sanitize filename
    const safeFilenameRegex = /^[a-zA-Z0-9_\-\.\s]+$/;
    if (!safeFilenameRegex.test(filename)) {
      log('warn', 'Unsafe filename pattern in process', { filename, traceId });
      return res.status(400).json({
        error: 'Invalid filename format',
      });
    }

    // Parse ratio and color
    const ratio = ratioStr ? parseRatio(ratioStr) : parseRatio('original');
    const color = colorStr ? parseColor(colorStr) : parseColor('#000000');

    if (!ratio) {
      return res.status(400).json({
        error: 'Invalid ratio format. Use format like "4:5" or "original"',
      });
    }

    if (!color) {
      return res.status(400).json({
        error: 'Invalid color format. Use hex color like "#000000" or "black"/"white"',
      });
    }

    const inputPath = path.join(TEMP_DIR, `${uploadId}_${filename}`);
    
    // Security: Verify path is inside TEMP_DIR
    const resolvedPath = path.resolve(inputPath);
    const resolvedTempDir = path.resolve(TEMP_DIR);
    if (!resolvedPath.startsWith(resolvedTempDir)) {
      log('error', 'Path traversal attempt in process', { uploadId, filename, traceId });
      return res.status(403).json({
        error: 'Access denied',
      });
    }

    // Check if file exists
    try {
      await fs.access(inputPath);
    } catch {
      return res.status(404).json({
        error: 'Uploaded file not found. Please upload again.',
      });
    }

    log('info', 'Processing image', {
      traceId,
      uploadId,
      filename,
      ratio: ratio.key,
      color,
    });

    // Read file
    const inputBuffer = await fs.readFile(inputPath);

    // Get metadata
    const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata();
    let fmt = meta && meta.format ? meta.format.toLowerCase() : 'jpeg';
    if (fmt === 'jpg') fmt = 'jpeg';

    // Validate format
    if (!['jpeg', 'png'].includes(fmt)) {
      return res.status(400).json({
        error: 'Unsupported image format. Only JPEG and PNG are supported.',
      });
    }

    // Process image
    const t0 = Date.now();
    const {
      buffer: outputBuffer,
      format: outputFormat,
      width,
      height,
    } = await noCropBuffer(inputBuffer, ratio, color, fmt);

    const processingTime = Date.now() - t0;

    // Generate output filename
    const ext = mapFormatToExt(outputFormat);
    const outputFilename = filename.replace(/\.[^.]+$/, '') +
      `_no_crop_${ratio.key.replace(':', 'x')}.${ext}`;
    const outputPath = path.join(OUTPUT_DIR, `${uploadId}_${outputFilename}`);

    // Save processed image
    await fs.writeFile(outputPath, outputBuffer);

    // Clean up input file
    await fs.unlink(inputPath).catch(() => {});

    // Create ProcessedFile document in MongoDB
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + DOWNLOAD_EXPIRY_HOURS);

    // Generate MongoDB ObjectId first
    const mongoose = require('mongoose');
    const fileId = new mongoose.Types.ObjectId();

    const processedFile = new ProcessedFile({
      _id: fileId,
      filename: `${uploadId}_${outputFilename}`,
      originalFilename: filename,
      filePath: outputPath,
      fileSize: outputBuffer.length,
      uploadId,
      traceId,
      width,
      height,
      format: outputFormat,
      ratio: ratio.key,
      color,
      processingTime,
      downloadUrl: `/api/process/download/${fileId}`,
      expiresAt,
      userIp: req.ip || req.connection.remoteAddress,
    });

    await processedFile.save();

    log('info', 'Image processed', {
      traceId,
      uploadId,
      fileId: processedFile._id.toString(),
      filename: outputFilename,
      inputSize: inputBuffer.length,
      outputSize: outputBuffer.length,
      width,
      height,
      format: outputFormat,
      ratio: ratio.key,
      color,
      processingTime: `${processingTime}ms`,
      expiresAt: expiresAt.toISOString(),
    });

    res.json({
      message: 'Image processed successfully',
      traceId,
      fileId: processedFile._id.toString(),
      filename: outputFilename,
      downloadUrl: processedFile.downloadUrl,
      expiresAt: expiresAt.toISOString(),
      expiresIn: `${DOWNLOAD_EXPIRY_HOURS} hours`,
      metadata: {
        width,
        height,
        format: outputFormat,
        size: outputBuffer.length,
        ratio: ratio.key,
        color,
        processingTime,
      },
    });
  } catch (err) {
    log('error', 'Process error', { traceId, error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/process/download/:fileId - Download processed image
router.get('/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Security: Validate fileId (MongoDB ObjectId format)
    if (!fileId || !/^[a-f0-9]{24}$/i.test(fileId)) {
      log('warn', 'Invalid fileId format', { fileId });
      return res.status(400).json({ 
        error: 'Invalid file ID' 
      });
    }

    // Find file in database
    const processedFile = await ProcessedFile.findById(fileId);
    
    if (!processedFile) {
      log('warn', 'File not found in database', { fileId });
      return res.status(404).json({ 
        error: 'File not found or has been deleted' 
      });
    }

    // Check if file is expired
    if (processedFile.isExpired()) {
      log('info', 'Attempted to download expired file', { 
        fileId, 
        expiresAt: processedFile.expiresAt 
      });
      return res.status(410).json({ 
        error: 'Download link has expired',
        expiredAt: processedFile.expiresAt.toISOString()
      });
    }

    const filePath = processedFile.filePath;

    // Check if file exists on disk
    try {
      await fs.access(filePath);
    } catch {
      log('error', 'File not found on disk', { fileId, filePath });
      return res.status(404).json({ 
        error: 'File not found on server' 
      });
    }

    // Validate it's a file (not directory)
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      log('warn', 'Attempted to download non-file', { fileId, filePath });
      return res.status(400).json({ error: 'Invalid file' });
    }

    // Increment download count
    await processedFile.incrementDownload();

    // Set headers (sanitize filename in header)
    const sanitizedFilename = path.basename(processedFile.originalFilename)
      .replace(/\.[^.]+$/, '') + 
      `_no_crop_${processedFile.ratio.replace(':', 'x')}.${processedFile.format === 'jpeg' ? 'jpg' : processedFile.format}`;
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}"`);
    res.setHeader('Content-Length', stats.size);

    // Stream file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      log('info', 'File downloaded', { 
        fileId,
        filename: processedFile.filename,
        downloadCount: processedFile.downloadCount 
      });
    });

    fileStream.on('error', (err) => {
      log('error', 'Download stream error', { 
        fileId, 
        filename: processedFile.filename,
        error: err.message 
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    });
  } catch (err) {
    log('error', 'Download error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
