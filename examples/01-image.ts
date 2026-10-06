// Generate an image, print its link, save it to a temp file.
//   npx tsx 01-image.ts "a red fox in an autumn forest"
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, ContentPolicyDeclinedError, InsufficientCreditsError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  const { images } = await relay.image.generate("Qwen/qwen-image", {
    prompt: process.argv[2] ?? "A red fox in an autumn forest",
    size: "1024x1024",
  });
  const image = images[0];
  console.log("url:", image.url); // a link that lives 1 h; pass { storeOutput: "relay7d" } to keep it longer

  const blob = await image.toBlob();
  const file = join(tmpdir(), `relay-image.${blob.type.split("/")[1] || "bin"}`);
  await writeFile(file, new Uint8Array(await blob.arrayBuffer()));
  console.log("saved:", file);
} catch (e) {
  // Status picks the class, error.code refines it: KeyBudgetExhaustedError is an InsufficientCreditsError (402).
  if (e instanceof InsufficientCreditsError) console.error(`out of credit (${e.code}), request ${e.requestId}`);
  else if (e instanceof ContentPolicyDeclinedError) console.error("the provider declined this prompt:", e.message);
  else throw e;
  process.exitCode = 1;
}
