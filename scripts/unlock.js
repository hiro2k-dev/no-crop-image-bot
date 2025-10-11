// Force-unlock a user by userId.
// Usage:
//   npm run unlock -- 123456789
require('dotenv').config();
const { connectMongo } = require('../src/db');
const { releaseLock } = require('../src/models/Lock');

const userId = process.argv.slice(2)[0];
if (!userId) {
  console.error('Usage: node scripts/unlock.js <userId>');
  process.exit(1);
}

(async () => {
  await connectMongo();
  await releaseLock(String(userId));
  console.log(`Unlocked user ${userId}`);
  process.exit(0);
})();
