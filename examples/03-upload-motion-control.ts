// Upload a local video, then transfer its motion onto a character image (Kling v3 Motion Control).
//   npx tsx 03-upload-motion-control.ts ./dance.mp4 https://example.com/character.png
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Relay, FileTooLargeError, ValidationError } from "@relaygpu/client";

const [videoPath, imageUrl] = process.argv.slice(2);
if (!videoPath || !imageUrl) {
  console.error("usage: npx tsx 03-upload-motion-control.ts <local video.mp4> <character image URL>");
  process.exit(2);
}

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });
const video = new Blob([new Uint8Array(await readFile(videoPath))]); // media type sniffed from the bytes

try {
  // Form 1, explicit: host the file yourself and get a link any *_url field takes.
  // relay1h is free; relay1d / relay7d / relay30d are billed per file (GET /v2/pricing → media_storage).
  const file = await relay.files.upload(video, { retention: "relay1d", filename: basename(videoPath) });
  console.log("uploaded:", file.file_id, file.url, "expires", file.expires_at);

  // Form 2, implicit: put the Blob straight into a *_url field; the SDK uploads it first (relay1h unless
  // opts.upload.retention says otherwise) and sends the link. `video_url: file.url` would work the same.
  const accepted = await relay.video.generate("KlingTeam/v3-Motion-Control", {
    video_url: video,
    image_url: imageUrl,
    character_orientation: "video", // "image" | "video": which input decides the facing direction
    duration: 5,
    quality_mode: "std",
  });
  // No wait: the 202 envelope. Poll later with relay.tasks.wait(accepted.task_id), or pass webhookUrl.
  console.log("task:", accepted.task_id, accepted.replayed ? "(replayed)" : "");

  // Take the explicit upload down now (idempotent; the fee is not refunded).
  await relay.files.delete(file.file_id);
  console.log("deleted:", file.file_id);
} catch (e) {
  if (e instanceof FileTooLargeError) console.error("files are capped at 100 MB");
  else if (e instanceof ValidationError) console.error(`rejected (${e.code}):`, e.message);
  else throw e;
  process.exitCode = 1;
}
