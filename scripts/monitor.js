// CLI monitoring:
//   npm run monitor
//   npm run monitor:watch
//   node scripts/monitor.js --watch --interval=2000
require("dotenv").config();
const { connectMongo } = require("../src/db");
const { Lock } = require("../src/models/Lock");
const { summaryStats } = require("../src/models/JobLog");

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { watch: false, interval: 5000 };
  for (const a of args) {
    if (a === "--watch") flags.watch = true;
    else if (a.startsWith("--interval=")) {
      const v = parseInt(a.split("=")[1], 10);
      if (!Number.isNaN(v) && v > 0) flags.interval = v;
    }
  }
  return flags;
}

async function once() {
  const [count, locks, jobStats] = await Promise.all([
    Lock.countDocuments({}),
    Lock.find({}).sort({ expiresAt: 1 }).limit(20).lean(),
    summaryStats(),
  ]);

  const now = new Date().toISOString();
  console.log(`\n[${now}] Stats:`);
  console.log(`- Active locks: ${count}`);
  console.log(`- Jobs: ${jobStats.totalJobs}`);
  console.log(`- Images processed: ${jobStats.totalImages}`);
  console.log(`- Total data: ${(jobStats.totalBytes / 1e6).toFixed(2)} MB`);
  console.log(`- Avg processing time: ${Math.round(jobStats.avgMs)} ms`);

  if (locks.length) {
    console.log("- Locks (up to 20):");
    for (const d of locks) {
      console.log(
        `  user=${d._id} trace=${d.traceId} exp=${d.expiresAt?.toISOString?.()}`
      );
    }
  } else {
    console.log("- Locks: (none)");
  }
}

(async () => {
  await connectMongo();
  const { watch, interval } = parseArgs();
  if (!watch) {
    await once();
    process.exit(0);
  }
  while (true) {
    await once();
    await new Promise((r) => setTimeout(r, interval));
  }
})();
