const { Telegraf } = require("telegraf");
const sharp = require("sharp");
const {
  BOT_TOKEN,
  ALBUM_AGGREGATE_MS,
  TELEGRAM_API_BASE,
} = require("./config");
const { log, genTraceId } = require("./logger");
const {
  parseRatio,
  parseColor,
  humanSettings,
  getUserState,
  setUserRatio,
  setUserColor,
} = require("./state");
const { acquireLock, releaseLock } = require("./models/Lock");
const { downloadFileBuffer, noCropBuffer, mapFormatToExt } = require("./image");
const { addJobLog } = require("./models/JobLog");

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { apiRoot: TELEGRAM_API_BASE },
});

// ---------------- Queue per user ----------------
const userQueues = new Map(); // userId -> [async job()]
const userRunning = new Set(); // userIds currently running

function enqueueJob(userId, job) {
  const id = String(userId);
  const q = userQueues.get(id) || [];
  q.push(job);
  userQueues.set(id, q);
  if (!userRunning.has(id)) runQueue(id);
  return q.length; // position
}

async function runQueue(userId) {
  const id = String(userId);
  if (userRunning.has(id)) return;
  userRunning.add(id);
  try {
    while ((userQueues.get(id) || []).length > 0) {
      const q = userQueues.get(id);
      const job = q.shift();
      try {
        await job();
      } catch (e) {
        log("error", "job failed", {
          userId: id,
          err: String(e?.message || e),
        });
      }
    }
  } finally {
    userRunning.delete(id);
    userQueues.delete(id);
  }
}

// ---------------- Helpers ----------------
/**
 * Process one image buffer and reply as document.
 * Returns { bytes, ms } for JobLog aggregation.
 */
async function processAndReplyImage(
  ctx,
  buf,
  fileNameHint,
  inputFmtHint,
  st,
  traceId,
  jobType = "photo"
) {
  const t0 = Date.now();
  const {
    buffer: out,
    format: fmt,
    width,
    height,
  } = await noCropBuffer(buf, st.ratio, st.color, inputFmtHint);

  const ext = mapFormatToExt(fmt);
  const filename =
    (fileNameHint ? fileNameHint.replace(/\.[^.]+$/, "") : "image") +
    `_no_crop_${st.ratio.key.replace(":", "x")}.${ext}`;

  log("info", "sending file", {
    traceId,
    filename,
    inputSize: buf.length,
    outputSize: out.length,
    ratio: st.ratio.key,
    format: fmt,
    width,
    height,
  });

  await ctx.replyWithDocument(
    { source: out, filename },
    { caption: `${st.ratio.key} | ${st.color}` }
  );

  const ms = Date.now() - t0;
  log("info", "sent document", {
    traceId,
    jobType,
    fmt,
    width,
    height,
    bytes: out.length,
    filename,
    ms,
  });

  return { bytes: out.length, ms };
}

async function makeSinglePhotoJob(
  ctx,
  fileId,
  fileNameHint,
  traceId,
  jobType = "photo"
) {
  const userId = String(ctx.from.id);
  const st = await getUserState(userId);

  return async () => {
    const tJob = Date.now();
    // Acquire per-user distributed lock
    const locked = await acquireLock(userId, traceId);
    if (!locked) {
      await new Promise((r) => setTimeout(r, 500));
      const retry = await acquireLock(userId, traceId);
      if (!retry) {
        log("warn", "lock busy, skip job", { userId, traceId });
        return;
      }
    }

    const waitMsg = await ctx.reply(
      "Got your image — please wait while I process it…"
    );

    let bytes = 0,
      ms = 0;
    try {
      await ctx.replyWithChatAction("upload_document");
      const buf = await downloadFileBuffer(ctx, fileId);
      const meta = await sharp(buf, { failOn: "none" }).metadata();
      const fmt = meta && meta.format ? meta.format.toLowerCase() : "jpeg";
      const res = await processAndReplyImage(
        ctx,
        buf,
        fileNameHint,
        fmt,
        st,
        traceId,
        jobType
      );
      bytes += res.bytes;
      ms += res.ms;
    } catch (err) {
      console.error(err);
      log("error", "processing photo", { traceId, userId, error: err.message });
      await ctx.reply("Processing error (photo).");
    } finally {
      await releaseLock(userId);
      try {
        await ctx.deleteMessage(waitMsg.message_id);
      } catch {}
      // JobLog for single image
      await addJobLog({
        _id: traceId,
        userId,
        type: jobType,
        count: 1,
        bytes,
        ms: Math.max(ms, Date.now() - tJob),
      });
    }
  };
}

async function makeAlbumJob(ctx, items, traceId) {
  const userId = String(ctx.from.id);
  const st = await getUserState(userId);

  return async () => {
    const tJob = Date.now();
    const locked = await acquireLock(userId, traceId);
    if (!locked) {
      await new Promise((r) => setTimeout(r, 500));
      const retry = await acquireLock(userId, traceId);
      if (!retry) {
        log("warn", "lock busy, skip album", { userId, traceId });
        return;
      }
    }

    const waitMsg = await ctx.reply(
      "Got your album — please wait while I process all images…"
    );

    let bytesTotal = 0;
    let msTotal = 0;

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const buf = await downloadFileBuffer(ctx, item.fileId);
        const meta = await sharp(buf, { failOn: "none" }).metadata();
        const fmt = meta && meta.format ? meta.format.toLowerCase() : "jpeg";
        const res = await processAndReplyImage(
          ctx,
          buf,
          item.fileName,
          fmt,
          st,
          `${traceId}_${i + 1}`,
          "photo"
        );
        bytesTotal += res.bytes;
        msTotal += res.ms;
      }
    } catch (err) {
      log("error", "album error", { traceId, userId, error: err.message });
      await ctx.reply("Processing error (album).");
    } finally {
      await releaseLock(userId);
      try {
        await ctx.deleteMessage(waitMsg.message_id);
      } catch {}
      // JobLog for album (one record summarizing the whole album)
      await addJobLog({
        _id: traceId,
        userId,
        type: "album",
        count: items.length,
        bytes: bytesTotal,
        ms: Math.max(msTotal, Date.now() - tJob),
      });
    }
  };
}

// ---------------- Commands ----------------
bot.start(async (ctx) => {
  const st = await getUserState(ctx.from.id);
  await ctx.reply(
    `Hi! I'm the “No-Crop Image” bot.
Send me an image (photo or document). I’ll add borders to match your ratio without scaling.

Commands:
/ratio 4:5
/color #000000
/settings
/help

Current:
${humanSettings(st)}`
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `Usage:
• Send an image — I'll return a no-crop version as a file.
• /ratio <w:h> or original
• /color <#RRGGBB|black|white>
• /settings

Notes:
• No scaling.
• Only padding to match aspect ratio.
• Albums (media groups) supported.
• Multiple images you send quickly will be queued and processed in order.`
  );
});

bot.command("settings", async (ctx) => {
  const st = await getUserState(ctx.from.id);
  await ctx.reply(`Current settings:\n${humanSettings(st)}`);
});

bot.command("ratio", async (ctx) => {
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const r = parseRatio(arg);
  if (!r) return ctx.reply("Usage: /ratio 4:5 or 16:9 or original");
  const st = await setUserRatio(ctx.from.id, r);
  await ctx.reply(`OK, ratio set to ${st.ratio.key}`);
});

bot.command("color", async (ctx) => {
  const arg = (ctx.message.text || "").split(/\s+/)[1];
  const c = parseColor(arg);
  if (!c) return ctx.reply("Usage: /color #000000 or black/white");
  const st = await setUserColor(ctx.from.id, c);
  await ctx.reply(`OK, border color set to ${st.color}`);
});

// ---------------- Media handlers ----------------
const albumCache = new Map(); // media_group_id -> { items: [], timer }

bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo || [];
  const largest = photos[photos.length - 1];
  if (!largest) return;

  const userId = String(ctx.from.id);
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // Aggregate album into one job
    if (!albumCache.has(mediaGroupId)) {
      albumCache.set(mediaGroupId, {
        items: [],
        timer: setTimeout(async () => {
          const entry = albumCache.get(mediaGroupId);
          if (!entry) return;
          albumCache.delete(mediaGroupId);

          const traceId = genTraceId();
          const job = await makeAlbumJob(ctx, entry.items, traceId);
          const pos = enqueueJob(userId, job);
          // if (pos > 1)
          //   await ctx.reply(
          //     `Queued (#${pos}). I'll process your album shortly.`
          //   );
        }, ALBUM_AGGREGATE_MS),
      });
    }
    const entry = albumCache.get(mediaGroupId);
    entry.items.push({
      fileId: largest.file_id,
      fileName: `album_${entry.items.length + 1}`,
    });
  } else {
    // Single photo → enqueue
    const traceId = genTraceId();
    const job = await makeSinglePhotoJob(
      ctx,
      largest.file_id,
      "photo",
      traceId,
      "photo"
    );
    const pos = enqueueJob(userId, job);
    // if (pos > 1) await ctx.reply(`Queued (#${pos}). I'll process it shortly.`);
  }
});

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc || !doc.mime_type || !doc.mime_type.startsWith("image/")) return;

  const userId = String(ctx.from.id);
  const traceId = genTraceId();

  const job = async () => {
    const st = await getUserState(userId);
    const tJob = Date.now();

    const locked = await acquireLock(userId, traceId);
    if (!locked) {
      await new Promise((r) => setTimeout(r, 500));
      const retry = await acquireLock(userId, traceId);
      if (!retry) {
        log("warn", "lock busy, skip doc", { userId, traceId });
        return;
      }
    }
    const waitMsg = await ctx.reply(
      "Got your image — please wait while I process it…"
    );
    let bytes = 0,
      ms = 0;

    try {
      const buf = await downloadFileBuffer(ctx, doc.file_id);
      const meta = await sharp(buf, { failOn: "none" }).metadata();
      const fmt =
        meta && meta.format
          ? meta.format.toLowerCase()
          : doc.mime_type.split("/")[1];
      const res = await processAndReplyImage(
        ctx,
        buf,
        doc.file_name,
        fmt,
        st,
        traceId,
        "document"
      );
      bytes += res.bytes;
      ms += res.ms;
    } catch (err) {
      log("error", "document error", { traceId, error: err.message });
      await ctx.reply("Processing error (document).");
    } finally {
      await releaseLock(userId);
      try {
        await ctx.deleteMessage(waitMsg.message_id);
      } catch {}
      await addJobLog({
        _id: traceId,
        userId,
        type: "document",
        count: 1,
        bytes,
        ms: Math.max(ms, Date.now() - tJob),
      });
    }
  };

  const pos = enqueueJob(userId, job);
  // if (pos > 1) await ctx.reply(`Queued (#${pos}). I'll process it shortly.`);
});

module.exports = { bot };
