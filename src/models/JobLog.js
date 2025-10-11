const { mongoose } = require("../db");

const JobLogSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // traceId
    userId: { type: String, index: true },
    type: {
      type: String,
      enum: ["photo", "album", "document"],
      required: true,
    },
    count: { type: Number, default: 1 },
    bytes: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

JobLogSchema.index({ createdAt: -1 });

const JobLog = mongoose.models.JobLog || mongoose.model("JobLog", JobLogSchema);

async function addJobLog(data) {
  await JobLog.create(data);
}

async function summaryStats() {
  const total = await JobLog.countDocuments({});
  const agg = await JobLog.aggregate([
    {
      $group: {
        _id: null,
        totalImages: { $sum: "$count" },
        totalBytes: { $sum: "$bytes" },
        avgMs: { $avg: "$ms" },
      },
    },
  ]);
  return { total, ...agg[0] };
}

module.exports = { JobLog, addJobLog, summaryStats };
