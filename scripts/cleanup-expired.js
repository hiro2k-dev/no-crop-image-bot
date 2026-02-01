const { connectMongo } = require('../src/db');
const ProcessedFile = require('../src/models/ProcessedFile');
const { log } = require('../src/logger');
const fs = require('fs').promises;

async function cleanupExpiredFiles() {
  console.log('Starting cleanup of expired files...\n');
  
  try {
    await connectMongo();
    console.log('Connected to MongoDB\n');

    // Find expired files
    const now = new Date();
    const expiredFiles = await ProcessedFile.find({
      expiresAt: { $lt: now }
    }).sort({ expiresAt: 1 });

    if (expiredFiles.length === 0) {
      console.log('No expired files found');
      process.exit(0);
    }

    console.log(`Found ${expiredFiles.length} expired files\n`);

    let deletedCount = 0;
    let failedCount = 0;
    let totalSize = 0;

    for (const file of expiredFiles) {
      try {
        const fileAge = Math.round((now - file.expiresAt) / (1000 * 60 * 60)); // hours
        console.log(`- ${file.filename}`);
        console.log(`  Expired: ${file.expiresAt.toISOString()} (${fileAge}h ago)`);
        console.log(`  Downloads: ${file.downloadCount}`);

        // Delete file from disk
        try {
          const stats = await fs.stat(file.filePath);
          totalSize += stats.size;
          await fs.unlink(file.filePath);
          console.log(`  [OK] Deleted from disk`);
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.log(`  [WARN] File already deleted from disk`);
          } else {
            console.log(`  [ERROR] Failed to delete from disk: ${err.message}`);
            throw err;
          }
        }

        // Delete from database
        await ProcessedFile.deleteOne({ _id: file._id });
        console.log(`  [OK] Deleted from database`);
        
        deletedCount++;
        
        log('info', 'Cleaned up expired file', {
          fileId: file._id.toString(),
          filename: file.filename,
          expiresAt: file.expiresAt,
          downloadCount: file.downloadCount,
        });

        console.log();
      } catch (err) {
        console.log(`  [ERROR] Failed: ${err.message}\n`);
        failedCount++;
        log('error', 'Failed to cleanup file', {
          fileId: file._id.toString(),
          filename: file.filename,
          error: err.message,
        });
      }
    }

    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    
    console.log('=' .repeat(50));
    console.log(`Cleanup completed`);
    console.log(`   Deleted: ${deletedCount} files (${sizeMB} MB)`);
    console.log(`   Failed: ${failedCount} files`);
    console.log('=' .repeat(50));

    process.exit(0);
  } catch (err) {
    console.error('Cleanup failed:', err.message);
    log('error', 'Cleanup job failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Run cleanup
cleanupExpiredFiles();
