const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { log, genTraceId } = require('../../logger');
const { DOWNLOAD_EXPIRY_HOURS } = require('../../config');
const ProcessedFile = require('../../models/ProcessedFile');

const TEMP_DIR = path.join(__dirname, '../../../uploads/temp');
const OUTPUT_DIR = path.join(__dirname, '../../../uploads/output');

// Ensure output directory exists
(async () => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
})();

// Valid layout types
const VALID_LAYOUT_TYPES = [
  '2-horizontal',
  '2-vertical',
  '3-row',
  '3-column',
  '3-left',
  '3-right'
];

/**
 * Calculate cell positions for each layout type
 */
function calculateCellPositions(layoutType, width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  
  switch (layoutType) {
    case '2-horizontal':
      return [
        { x: 0, y: 0, width: Math.round(w / 2), height: h },
        { x: Math.round(w / 2), y: 0, width: Math.round(w / 2), height: h }
      ];
    
    case '2-vertical':
      return [
        { x: 0, y: 0, width: w, height: Math.round(h / 2) },
        { x: 0, y: Math.round(h / 2), width: w, height: Math.round(h / 2) }
      ];
    
    case '3-row':
      return [
        { x: 0, y: 0, width: Math.round(w / 3), height: h },
        { x: Math.round(w / 3), y: 0, width: Math.round(w / 3), height: h },
        { x: Math.round(2 * w / 3), y: 0, width: Math.round(w / 3), height: h }
      ];
    
    case '3-column':
      return [
        { x: 0, y: 0, width: w, height: Math.round(h / 3) },
        { x: 0, y: Math.round(h / 3), width: w, height: Math.round(h / 3) },
        { x: 0, y: Math.round(2 * h / 3), width: w, height: Math.round(h / 3) }
      ];
    
    case '3-left':
      return [
        { x: 0, y: 0, width: Math.round(w / 2), height: h },
        { x: Math.round(w / 2), y: 0, width: Math.round(w / 2), height: Math.round(h / 2) },
        { x: Math.round(w / 2), y: Math.round(h / 2), width: Math.round(w / 2), height: Math.round(h / 2) }
      ];
    
    case '3-right':
      return [
        { x: 0, y: 0, width: Math.round(w / 2), height: Math.round(h / 2) },
        { x: 0, y: Math.round(h / 2), width: Math.round(w / 2), height: Math.round(h / 2) },
        { x: Math.round(w / 2), y: 0, width: Math.round(w / 2), height: h }
      ];
    
    default:
      throw new Error(`Unknown layout type: ${layoutType}`);
  }
}

/**
 * Process image with zoom and fit to cell
 * Keep original quality, only crop/position as needed
 */
async function processImageForCell(imageBuffer, cell, zoom) {
  const { width: cellWidth, height: cellHeight } = cell;
  
  // Get original image metadata (no downscale)
  const metadata = await sharp(imageBuffer).metadata();
  const { width: imgWidth, height: imgHeight } = metadata;
  
  // Calculate aspect ratios
  const cellRatio = cellWidth / cellHeight;
  const imageRatio = imgWidth / imgHeight;
  
  // Calculate dimensions to fill cell (keeping original quality)
  let targetWidth, targetHeight;
  
  if (imageRatio > cellRatio) {
    // Image is wider - fit to height, then zoom
    targetHeight = Math.round(cellHeight * zoom);
    targetWidth = Math.round(targetHeight * imageRatio);
  } else {
    // Image is taller - fit to width, then zoom
    targetWidth = Math.round(cellWidth * zoom);
    targetHeight = Math.round(targetWidth / imageRatio);
  }
  
  // Resize and crop to exact cell size
  // Sharp will keep quality as high as possible
  const processedImage = sharp(imageBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'cover',
      position: 'centre',
      kernel: 'lanczos3' // High quality resampling
    })
    .extract({
      left: Math.max(0, Math.round((targetWidth - cellWidth) / 2)),
      top: Math.max(0, Math.round((targetHeight - cellHeight) / 2)),
      width: cellWidth,
      height: cellHeight
    });
  
  return processedImage.toBuffer();
}

// POST /api/layout/process - Process multiple images into layout
router.post('/process', async (req, res) => {
  const traceId = genTraceId();
  
  try {
    const {
      layoutType,
      ratio,
      backgroundColor,
      dimensions,
      images
    } = req.body;
    
    // Validation
    if (!layoutType || !dimensions || !images) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'layoutType, dimensions, and images are required'
      });
    }
    
    // Validate layout type
    if (!VALID_LAYOUT_TYPES.includes(layoutType)) {
      return res.status(400).json({
        error: 'Invalid layout type',
        message: `layoutType must be one of: ${VALID_LAYOUT_TYPES.join(', ')}`
      });
    }
    
    // Validate dimensions
    if (!dimensions.width || !dimensions.height) {
      return res.status(400).json({
        error: 'Invalid dimensions',
        message: 'dimensions.width and dimensions.height are required'
      });
    }
    
    // Validate images array
    if (!Array.isArray(images) || images.length < 2 || images.length > 3) {
      return res.status(400).json({
        error: 'Invalid images',
        message: 'images must be an array with 2-3 items'
      });
    }
    
    // Validate image count matches layout
    const expectedCount = layoutType.startsWith('2-') ? 2 : 3;
    if (images.length !== expectedCount) {
      return res.status(400).json({
        error: 'Image count mismatch',
        message: `Layout type '${layoutType}' requires ${expectedCount} images, got ${images.length}`
      });
    }
    
    // Security: Validate each image
    for (const img of images) {
      if (!img.uploadId || !img.filename) {
        return res.status(400).json({
          error: 'Invalid image data',
          message: 'Each image must have uploadId and filename'
        });
      }
      
      // Security: Validate uploadId format (32 char hex)
      if (!/^[a-f0-9]{32}$/.test(img.uploadId)) {
        log('warn', 'Invalid uploadId format in layout', { uploadId: img.uploadId, traceId });
        return res.status(400).json({
          error: 'Invalid uploadId format',
          message: `Invalid uploadId: ${img.uploadId}`
        });
      }
      
      // Security: Validate filename
      if (img.filename.includes('..') || img.filename.includes('/') || img.filename.includes('\\')) {
        log('warn', 'Path traversal attempt in filename', { filename: img.filename, traceId });
        return res.status(400).json({
          error: 'Invalid filename',
          message: `Invalid filename: ${img.filename}`
        });
      }
      
      // Security: Sanitize filename
      const safeFilenameRegex = /^[a-zA-Z0-9_\-\.\s]+$/;
      if (!safeFilenameRegex.test(img.filename)) {
        log('warn', 'Unsafe filename pattern in layout', { filename: img.filename, traceId });
        return res.status(400).json({
          error: 'Invalid filename format',
          message: `Invalid filename format: ${img.filename}`
        });
      }
      
      // Validate zoom
      if (img.zoom && (img.zoom < 0.5 || img.zoom > 3.0)) {
        return res.status(400).json({
          error: 'Invalid zoom',
          message: 'zoom must be between 0.5 and 3.0'
        });
      }
    }
    
    log('info', 'Processing layout', {
      traceId,
      layoutType,
      dimensionsFromFE: dimensions,
      imageCount: images.length,
      backgroundColor
    });
    
    // Load all images first to get original dimensions
    const loadedImages = [];
    
    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      
      // Build input path
      const inputPath = path.join(TEMP_DIR, `${imageData.uploadId}_${imageData.filename}`);
      
      // Security: Verify path is inside TEMP_DIR
      const resolvedPath = path.resolve(inputPath);
      const resolvedTempDir = path.resolve(TEMP_DIR);
      if (!resolvedPath.startsWith(resolvedTempDir)) {
        log('error', 'Path traversal attempt in layout', { 
          uploadId: imageData.uploadId, 
          filename: imageData.filename, 
          traceId 
        });
        return res.status(403).json({
          error: 'Access denied'
        });
      }
      
      // Check if file exists
      try {
        await fs.access(inputPath);
      } catch {
        return res.status(404).json({
          error: 'Upload not found',
          message: `Upload ID '${imageData.uploadId}' not found or has expired`
        });
      }
      
      // Load image
      const imageBuffer = await fs.readFile(inputPath);
      const metadata = await sharp(imageBuffer).metadata();
      
      loadedImages.push({
        buffer: imageBuffer,
        width: metadata.width,
        height: metadata.height,
        size: imageBuffer.length,
        data: imageData,
        inputPath
      });
    }
    
    // Calculate scale factor based on largest dimension
    const maxOriginalWidth = Math.max(...loadedImages.map(img => img.width));
    const maxOriginalHeight = Math.max(...loadedImages.map(img => img.height));
    
    // Scale factor: use original image dimensions
    const scaleX = maxOriginalWidth / dimensions.width;
    const scaleY = maxOriginalHeight / dimensions.height;
    const scaleFactor = Math.max(scaleX, scaleY);
    
    // Calculate actual canvas dimensions
    const actualWidth = Math.round(dimensions.width * scaleFactor);
    const actualHeight = Math.round(dimensions.height * scaleFactor);
    
    log('info', 'Calculated canvas dimensions', {
      traceId,
      feWidth: dimensions.width,
      feHeight: dimensions.height,
      maxOriginalWidth,
      maxOriginalHeight,
      scaleFactor: scaleFactor.toFixed(2),
      actualWidth,
      actualHeight
    });
    
    // Calculate cell positions based on ACTUAL dimensions
    const cells = calculateCellPositions(layoutType, actualWidth, actualHeight);
    
    // Process each image
    const processedImages = [];
    const inputSizes = [];
    const imageDimensions = [];
    
    for (let i = 0; i < loadedImages.length; i++) {
      const loadedImage = loadedImages[i];
      const cell = cells[loadedImage.data.position];
      const zoom = loadedImage.data.zoom || 1.0;
      
      inputSizes.push(loadedImage.size);
      imageDimensions.push(`${loadedImage.width}×${loadedImage.height}`);
      
      // Process image for cell
      const processedBuffer = await processImageForCell(loadedImage.buffer, cell, zoom);
      
      processedImages.push({
        buffer: processedBuffer,
        cell,
        position: loadedImage.data.position
      });
      
      // Clean up input file
      await fs.unlink(loadedImage.inputPath).catch(() => {});
    }
    
    // Sort by position
    processedImages.sort((a, b) => a.position - b.position);
    
    // Create canvas with background color
    const bgColor = backgroundColor || '#FFFFFF';
    const bgRgb = {
      r: parseInt(bgColor.slice(1, 3), 16),
      g: parseInt(bgColor.slice(3, 5), 16),
      b: parseInt(bgColor.slice(5, 7), 16)
    };
    
    // Create base canvas
    const canvas = sharp({
      create: {
        width: actualWidth,
        height: actualHeight,
        channels: 3,
        background: bgRgb
      }
    });
    
    // Composite all images onto canvas
    const compositeOperations = processedImages.map(img => ({
      input: img.buffer,
      top: img.cell.y,
      left: img.cell.x
    }));
    
    const outputBuffer = await canvas
      .composite(compositeOperations)
      .jpeg({ 
        quality: 95, // High quality
        mozjpeg: true // Better compression
      })
      .toBuffer();
    
    // Generate output filename
    const timestamp = Date.now();
    const outputFilename = `layout_${layoutType}_${timestamp}.jpg`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);
    
    // Save processed image
    await fs.writeFile(outputPath, outputBuffer);
    
    // Create ProcessedFile document in MongoDB
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + DOWNLOAD_EXPIRY_HOURS);
    
    // Generate MongoDB ObjectId first
    const mongoose = require('mongoose');
    const fileId = new mongoose.Types.ObjectId();
    
    const processedFile = new ProcessedFile({
      _id: fileId,
      filename: outputFilename,
      originalFilename: `layout_${layoutType}.jpg`,
      filePath: outputPath,
      fileSize: outputBuffer.length,
      uploadId: images[0].uploadId, // Use first image's uploadId
      traceId,
      width: actualWidth,
      height: actualHeight,
      format: 'jpeg',
      ratio: ratio || 'custom',
      color: backgroundColor || '#FFFFFF',
      downloadUrl: `/api/process/download/${fileId}`,
      expiresAt,
      userIp: req.ip || req.connection.remoteAddress,
    });
    
    await processedFile.save();
    
    log('info', 'Layout processed', {
      traceId,
      fileId: processedFile._id.toString(),
      layoutType,
      filename: outputFilename,
      imageDimensions,
      inputSizes: inputSizes.map(s => `${(s / 1024 / 1024).toFixed(2)}MB`),
      totalInputSize: `${(inputSizes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(2)}MB`,
      feDimensions: `${dimensions.width}×${dimensions.height}`,
      scaleFactor: scaleFactor.toFixed(2),
      actualCanvasSize: `${actualWidth}×${actualHeight}`,
      outputSize: `${(outputBuffer.length / 1024 / 1024).toFixed(2)}MB`,
      outputSizeBytes: outputBuffer.length,
      expiresAt: expiresAt.toISOString(),
    });
    
    res.json({
      fileId: processedFile._id.toString(),
      filename: outputFilename,
      downloadUrl: processedFile.downloadUrl,
      expiresAt: expiresAt.toISOString(),
      expiresIn: `${DOWNLOAD_EXPIRY_HOURS} hours`,
      metadata: {
        width: actualWidth,
        height: actualHeight,
        format: 'jpeg',
        size: outputBuffer.length
      }
    });
  } catch (err) {
    log('error', 'Layout process error', { 
      traceId, 
      error: err.message, 
      stack: err.stack 
    });
    
    res.status(500).json({ 
      error: 'Processing failed',
      message: err.message 
    });
  }
});

module.exports = router;
