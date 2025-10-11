const { MONGO_URI } = require("./config");
const {
  getOrCreateUserConfig,
  updateUserConfig,
} = require("./models/UserConfig");

const PERSIST = !!MONGO_URI; // if no Mongo, fallback to in-memory only

// Aspect ratio presets
const PRESETS = new Map([
  ["original", { key: "original", w: 0, h: 0 }],
  ["1:1", { key: "1:1", w: 1, h: 1 }],
  ["4:5", { key: "4:5", w: 4, h: 5 }],
  ["5:4", { key: "5:4", w: 5, h: 4 }],
  ["16:9", { key: "16:9", w: 16, h: 9 }],
  ["9:16", { key: "9:16", w: 9, h: 16 }],
  ["3:2", { key: "3:2", w: 3, h: 2 }],
  ["2:3", { key: "2:3", w: 2, h: 3 }],
]);

// In-memory cache: userId -> { ratio: {key,w,h}, color: '#xxxxxx' }
const cache = new Map();

function parseRatio(input) {
  const key = String(input || "")
    .trim()
    .toLowerCase();
  if (PRESETS.has(key)) return PRESETS.get(key);
  const m = key.match(/^(\d+)\s*[:x]\s*(\d+)$/i);
  if (!m) return null;
  const w = parseInt(m[1], 10),
    h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return { key: `${w}:${h}`, w, h };
}

function parseColor(input) {
  const s = String(input || "").trim();
  if (/^#([0-9a-fA-F]{3}){1,2}$/.test(s)) return s;
  if (/^(black|white)$/i.test(s))
    return s.toLowerCase() === "white" ? "#ffffff" : "#000000";
  return null;
}

function humanSettings(st) {
  return `Ratio: ${st.ratio.key}\nBorder: ${st.color}`;
}

// Convert DB doc -> state object
function docToState(doc) {
  const r = parseRatio(doc?.ratio || "4:5") || PRESETS.get("4:5");
  const c = doc?.color || "#000000";
  return { ratio: r, color: c };
}

// ---------- Public API (async) ----------
async function getUserState(userId) {
  const id = String(userId);
  if (cache.has(id)) return cache.get(id);

  // Load from DB if possible, else default
  let st;
  if (PERSIST) {
    const doc = await getOrCreateUserConfig(id);
    st = docToState(doc);
  } else {
    st = { ratio: PRESETS.get("4:5"), color: "#000000" };
  }
  cache.set(id, st);
  return st;
}

async function setUserRatio(userId, ratioObj) {
  const id = String(userId);
  const st = await getUserState(id);
  st.ratio = ratioObj;
  cache.set(id, st);
  if (PERSIST) {
    await updateUserConfig(id, { ratio: ratioObj.key });
  }
  return st;
}

async function setUserColor(userId, colorHex) {
  const id = String(userId);
  const st = await getUserState(id);
  st.color = colorHex;
  cache.set(id, st);
  if (PERSIST) {
    await updateUserConfig(id, { color: colorHex });
  }
  return st;
}

module.exports = {
  PRESETS,
  parseRatio,
  parseColor,
  humanSettings,
  getUserState,
  setUserRatio,
  setUserColor,
};
