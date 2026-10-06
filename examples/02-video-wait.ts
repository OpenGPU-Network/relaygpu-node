// Generate a video and wait for it (long-polls the task; video takes minutes).
//   npx tsx 02-video-wait.ts "a paper boat drifting down a rain gutter"
import { Relay, TaskFailedError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  const task = await relay.video.generate(
    "KlingTeam/v3-T2V",
    { prompt: process.argv[2] ?? "A paper boat drifting down a rain gutter", duration: 3, quality_mode: "std" },
    {
      wait: true,
      // Status transitions and elapsed time only: there is no queue position, log stream or cancel.
      onProgress: (p) => console.log(`${p.status} after ${p.elapsed_seconds}s`),
    },
  );
  const urls = task.result?.urls as string[] | undefined;
  console.log("video:", urls?.[0]); // expires 1 h after completion unless you pass storeOutput
} catch (e) {
  // The task ran and failed: e.code is the task's error_code (e.g. CONTENT_POLICY_DECLINED, UPSTREAM_TIMEOUT).
  if (e instanceof TaskFailedError) console.error(`task ${e.taskId} failed: ${e.code ?? "unclassified"}: ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
