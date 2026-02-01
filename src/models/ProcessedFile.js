const mongoose = require('mongoose');

const ProcessedFileSchema = new mongoose.Schema({
  // File info
  filename: {
    type: String,
    required: true,
  },
  originalFilename: {
    type: String,
    required: true,
  },
  filePath: {
    type: String,
    required: true,
  },
  fileSize: {
    type: Number,
    required: true,
  },
  
  // Processing info
  uploadId: {
    type: String,
    required: true,
    index: true,
  },
  traceId: {
    type: String,
    required: true,
  },
  
  // Image metadata
  width: Number,
  height: Number,
  format: String,
  ratio: String,
  color: String,
  processingTime: Number,
  
  // Download info
  downloadUrl: {
    type: String,
    required: true,
  },
  downloadCount: {
    type: Number,
    default: 0,
  },
  lastDownloadAt: Date,
  
  // Expiry
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  
  // User info (optional)
  userId: String,
  userIp: String,
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for cleanup job
ProcessedFileSchema.index({ expiresAt: 1 });

// Update updatedAt on save
ProcessedFileSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Check if file is expired
ProcessedFileSchema.methods.isExpired = function() {
  return new Date() > this.expiresAt;
};

// Increment download count
ProcessedFileSchema.methods.incrementDownload = async function() {
  this.downloadCount += 1;
  this.lastDownloadAt = new Date();
  await this.save();
};

const ProcessedFile = mongoose.model('ProcessedFile', ProcessedFileSchema);

module.exports = ProcessedFile;
