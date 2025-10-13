const axios = require("axios");
const sharp = require("sharp");
const { fileURLToPath } = require("url");
const fs = require("fs/promises");

// Only accept jpeg/jpg and png
function isAllowedFormat(fmt) {
  return fmt === "jpeg" || fmt === "jpg" || fmt === "png";
}

function mapFormatToExt(fmt) {
  return fmt === "jpeg" ? "jpg" : fmt;
}

async function downloadFileBuffer(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const href = link?.href || String(link);

  console.log(`Downloading file from ${href}`);

  if (href.startsWith("file:")) {
    let localPath;
    try {
      localPath = fileURLToPath(href);
    } catch (e) {
      const u = new URL(href);
      localPath = decodeURIComponent(u.pathname);
    }
    const data = await fs.readFile(localPath);
    return Buffer.from(data);
  }

  // http/https fallback
  const res = await axios.get(href, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function noCropBuffer(buf, ratio, borderHex, inputFormatHint) {
  const base = sharp(buf, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const W = meta.width,
    H = meta.height;

  // normalize and restrict to jpeg/png
  let fmt = (inputFormatHint || meta.format || "jpeg").toLowerCase();
  if (fmt === "jpg") fmt = "jpeg";
  if (!isAllowedFormat(fmt)) {
    fmt = "jpeg";
  }

  if (!ratio || ratio.key === "original" || !ratio.w || !ratio.h) {
    return { buffer: buf, format: fmt, width: W, height: H };
  }

  const r = ratio.w / ratio.h;
  let Cw = Math.max(W, Math.ceil(r * H));
  let Ch = Math.ceil(Cw / r);
  if (Ch < H) {
    Ch = H;
    Cw = Math.ceil(r * Ch);
  }

  const left = Math.floor((Cw - W) / 2);
  const right = Cw - W - left;
  const top = Math.floor((Ch - H) / 2);
  const bottom = Ch - H - top;

  let pipeline = base.extend({
    top,
    bottom,
    left,
    right,
    background: borderHex,
  });

  // Encode sane defaults to avoid bloat
  if (fmt === "jpeg") {
    pipeline = pipeline.jpeg({
      quality: 92,
      chromaSubsampling: "4:2:0",
      progressive: true,
      mozjpeg: true,
    });
  } else if (fmt === "png") {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  const out = await pipeline.toBuffer();
  return { buffer: out, format: fmt, width: Cw, height: Ch };
}

module.exports = {
  mapFormatToExt,
  downloadFileBuffer,
  noCropBuffer,
};
