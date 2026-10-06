// Chat needs no Relay SDK: point the OpenAI SDK (or the Anthropic one, at /v2/anthropic) at Relay.
//   npx tsx 06-chat-base-url.ts
import OpenAI from "openai";

const base = process.env.RELAY_BASE_URL ?? "https://relaygpu.com";
const openai = new OpenAI({ apiKey: process.env.RELAY_API_KEY, baseURL: `${base}/v2/openai/v1` });

const completion = await openai.chat.completions.create({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Say hello in five words." }],
  max_tokens: 20,
});
console.log(completion.choices[0].message.content);
