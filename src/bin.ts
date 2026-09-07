#!/usr/bin/env node
import { buildProgram } from "./cli/program.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
