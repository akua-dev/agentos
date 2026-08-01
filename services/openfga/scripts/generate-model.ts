import { AgentOSOpenFgaAuthorizationModelV1 } from "../../../packages/agentos/src/access/openfga.ts";

const modelUrl = new URL("../model/agentos-access-v1.json", import.meta.url);
const expected = `${JSON.stringify(AgentOSOpenFgaAuthorizationModelV1, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await Bun.file(modelUrl).text();
  if (current !== expected) {
    console.error("OpenFGA model artifact is stale; run bun run model:generate");
    process.exit(1);
  }
} else {
  await Bun.write(modelUrl, expected);
}
