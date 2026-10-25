#!/usr/bin/env node
/**
 * Generate docs/tools.md from the server catalog.
 * Run with: npm run docs:tools
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// Import the built modules
const { getToolCatalog } = await import(path.join(root, 'dist/server-registry.js'));
const { buildServer } = await import(path.join(root, 'dist/server.js'));

const catalog = getToolCatalog(buildServer());

const lines = catalog.map(t => {
  const hints = [
    t.annotations.readOnlyHint ? 'read-only' : 'write',
    t.annotations.destructiveHint ? 'destructive' : null
  ].filter(Boolean).join(' · ');
  return `| ${t.name} | ${t.title} | ${t.minimumProfile} | ${hints} |`;
}).join('\n');

const output = `# Tool reference

Auto-generated from the server catalog. Do not edit manually.

| Tool | Title | Min profile | Hints |
| --- | --- | --- | --- |
${lines}
`;

fs.writeFileSync(path.join(root, 'docs/tools.md'), output);
console.log('docs/tools.md generated');