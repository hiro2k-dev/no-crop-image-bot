const { mongoose } = require("../db");

const UserConfigSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Telegram user ID
    ratio: { type: String, default: "4:5" }, // store as "w:h" or "original"
    color: { type: String, default: "#000000" },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

UserConfigSchema.index({ updatedAt: -1 });

const UserConfig =
  mongoose.models.UserConfig || mongoose.model("UserConfig", UserConfigSchema);

async function getOrCreateUserConfig(userId) {
  const id = String(userId);
  const found = await UserConfig.findById(id);
  if (found) return found;
  return await UserConfig.create({ _id: id });
}

async function updateUserConfig(userId, data) {
  const id = String(userId);
  return await UserConfig.findByIdAndUpdate(
    id,
    { $set: { ...data, updatedAt: new Date() } },
    { upsert: true, new: true }
  );
}

module.exports = { UserConfig, getOrCreateUserConfig, updateUserConfig };
