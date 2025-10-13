const axios = require("axios");
const sharp = require("sharp");

function isSharpWritableFormat(fmt) {
  return ["jpeg", "png", "webp", "tiff", "avif", "heif"].includes(fmt);
}

function mapFormatToExt(fmt) {
  return fmt === "jpeg" ? "jpg" : fmt;
}

async function downloadFileBuffer(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  console.log("Downloading file from", link.href);

  const href = link?.href || String(link);
  if (href.startsWith("file:")) {
    const localPath = fileURLToPath(href); // Convert file:///var/lib/... → /var/lib/...
    const data = await fs.readFile(localPath);
    return Buffer.from(data);
  }
  const res = await axios.get(href, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function noCropBuffer(buf, ratio, borderHex, inputFormatHint) {
  const base = sharp(buf, { failOn: "none" }).rotate();
  const meta = await base.metadata();
  const W = meta.width,
    H = meta.height;

  let fmt = (inputFormatHint || meta.format || "jpeg").toLowerCase();
  if (!isSharpWritableFormat(fmt)) fmt = "png";

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

  if (fmt === "jpeg")
    pipeline = pipeline.jpeg({ quality: 100, chromaSubsampling: "4:4:4" });
  else if (fmt === "png") pipeline = pipeline.png({ compressionLevel: 9 });
  else if (fmt === "webp")
    pipeline = pipeline.webp({ quality: 100, lossless: true });
  else if (fmt === "tiff") pipeline = pipeline.tiff({ quality: 100 });
  else if (fmt === "avif")
    pipeline = pipeline.avif({ quality: 100, lossless: true });
  else if (fmt === "heif")
    pipeline = pipeline.heif({ quality: 100, lossless: true });

  const out = await pipeline.toBuffer();
  return { buffer: out, format: fmt, width: Cw, height: Ch };
}

module.exports = {
  mapFormatToExt,
  downloadFileBuffer,
  noCropBuffer,
};
