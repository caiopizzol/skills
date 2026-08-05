#!/usr/bin/env -S bun --no-env-file

import { resolve } from "node:path";
import { collectDiscordConversation } from "./collector.ts";

const [permalink, ...arguments_] = Bun.argv.slice(2);
const artifactsIndex = arguments_.indexOf("--artifacts-dir");
const artifactsDirectory = artifactsIndex >= 0 ? arguments_[artifactsIndex + 1] : undefined;

if (!permalink || !artifactsDirectory || artifactsIndex !== 0 || arguments_.length !== 2) {
  console.error(
    "Usage: bun --no-env-file collect.ts <discord-message-permalink> --artifacts-dir <directory>",
  );
  process.exit(2);
}

const token = Bun.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("DISCORD_BOT_TOKEN is required through the runtime environment");
  process.exit(2);
}

try {
  const result = await collectDiscordConversation(permalink, {
    token,
    artifactsDirectory: resolve(artifactsDirectory),
  });
  console.log(`Discord conversation: ${result.conversation.rootMessageId}`);
  console.log(`Run directory: ${result.runDirectory}`);
  console.log(`Messages: ${result.messages.length}`);
  console.log(
    `Files: ${result.files.filter((file) => file.status === "retrieved").length}/${result.files.length}`,
  );
  console.log(`External references: ${result.externalReferences.length}`);
  console.log(`Gaps: ${result.gaps.length}`);
  process.exit(result.gaps.length === 0 ? 0 : 3);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
