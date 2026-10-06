// Run a workflow (an LLM writes a line, a TTS model speaks it) and wait for the result.
//   npx tsx 05-workflow-run.ts "a lighthouse at dusk"
import { Relay, TaskFailedError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  // Inputs follow the template's input_schema: relay.workflows.get("script-voiceover").
  // Each step is billed as an ordinary request. Pass webhookUrl for one signed workflow.* delivery instead of waiting.
  const run = await relay.workflows.run(
    "script-voiceover",
    { messages: [{ role: "user", content: process.argv[2] ?? "a lighthouse at dusk" }], voice: "Cherry" },
    { wait: true, onProgress: (r) => console.log(r.status) },
  );
  console.log("run:", run.run_id, run.status);
  console.log("output:", JSON.stringify(run.output, null, 2)); // the last step's output (the speech)
} catch (e) {
  // A failed or cancelled run throws; e.task is the run as polled.
  if (e instanceof TaskFailedError) console.error(`run ${e.taskId} did not complete: ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
