#!/usr/bin/env node

import process from 'node:process';

import { publicErrorMessage, runMaintenanceCli } from './cli.ts';

runMaintenanceCli().catch((error: unknown) => {
  process.stderr.write(`${publicErrorMessage(error)}\n`);
  process.exitCode = 1;
});
