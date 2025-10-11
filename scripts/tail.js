// Tail the JSON log file set by LOG_FILE env.
// Usage:
//   npm run tail                 # tail -n 200 -f (as configured in package.json)
//   node scripts/tail.js -n 100  # last 100 lines
//   node scripts/tail.js -n 200 -f
require('dotenv').config();
const fs = require('fs');

const LOG_FILE = process.env.LOG_FILE;
if (!LOG_FILE) {
  console.error('LOG_FILE is not set. Set it in .env to enable file logging.');
  process.exit(1);
}

let n = 200;
let follow = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-n' && args[i+1]) {
    n = parseInt(args[i+1], 10) || n;
    i++;
  } else if (args[i] === '-f') {
    follow = true;
  }
}

function tailFile(file, lines = 100) {
  const data = fs.readFileSync(file, 'utf8');
  const arr = data.trim().split('\n');
  const last = arr.slice(-lines);
  console.log(last.join('\n'));
}

tailFile(LOG_FILE, n);

if (follow) {
  let pos = fs.statSync(LOG_FILE).size;
  fs.watch(LOG_FILE, (event) => {
    if (event !== 'change') return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < pos) { pos = stat.size; return; }
    const stream = fs.createReadStream(LOG_FILE, { start: pos, end: stat.size });
    stream.on('data', chunk => process.stdout.write(chunk));
    stream.on('end', () => { pos = stat.size; });
  });
}
