const { mongoose } = require("../db");
const { LOCK_TTL_MS } = require("../config");

const LockSchema = new mongoose.Schema(
  {
    _id: { type: String }, // userId
    locked: { type: Boolean, default: true },
    traceId: { type: String },
    expiresAt: { type: Date },
  },
  { versionKey: false }
);

LockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Lock = mongoose.models.Lock || mongoose.model("Lock", LockSchema);

/**
 * Acquire per-user lock (cluster-safe).
 * Returns true if acquired, false if someone else holds it.
 */
async function acquireLock(userId, traceId) {
  const id = String(userId);
  const now = Date.now();
  const expiresAt = new Date(now + LOCK_TTL_MS);

  // 1) Try to UPDATE an existing unlocked/expired lock to locked:true (NO upsert)
  const updated = await Lock.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { locked: { $ne: true } }, // not locked
        { expiresAt: { $lte: new Date(now) } }, // expired (TTL may not have removed yet)
      ],
    },
    { $set: { locked: true, traceId, expiresAt } },
    { new: true }
  );
  if (updated) return true;

  // 2) If no doc matched, try to INSERT a fresh lock.
  //    If someone else inserts in between, we'll hit E11000 and return false.
  try {
    await Lock.create({ _id: id, locked: true, traceId, expiresAt });
    return true;
  } catch (e) {
    if (e && e.code === 11000) {
      // Another process grabbed it at the same time.
      return false;
    }
    throw e;
  }
}

/** Release lock (best effort) */
async function releaseLock(userId) {
  await Lock.deleteOne({ _id: String(userId) });
}

/** List current locks (for external monitor script) */
async function listLocks(limit = 50) {
  return await Lock.find({}).limit(limit).lean();
}

module.exports = { Lock, acquireLock, releaseLock, listLocks };
