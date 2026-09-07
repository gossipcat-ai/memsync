import { createInterface } from "node:readline/promises";
import type { GistSummary } from "../backends/gist-backend.js";

export type PromptFn = (question: string) => Promise<string>;

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Prints a numbered list of candidate gists and asks the user to pick one by
// number. Returns the selected gist's id, or `undefined` on an invalid/
// out-of-range answer (the caller is expected to bail out with a non-zero
// exit code in that case — this does not loop to re-prompt).
export async function selectGistInteractively(
  gists: GistSummary[],
  promptFn: PromptFn = defaultPrompt,
): Promise<string | undefined> {
  console.log("Multiple memsync gists found on your GitHub account:");
  gists.forEach((gist, index) => {
    const lastUpdated = new Date(gist.updatedAt).toLocaleString();
    console.log(`  ${index + 1}. ${gist.id}  (last updated ${lastUpdated})`);
  });
  const answer = await promptFn(`Pick a gist to attach to (1-${gists.length}): `);
  const selection = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > gists.length) {
    console.error(`Invalid selection: ${answer}`);
    return undefined;
  }
  return gists[selection - 1].id;
}
