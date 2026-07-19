import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..');
const sourceDir = path.join(rootDir, 'src', 'lib', 'data');
const targetDir = path.join(rootDir, 'static', 'deps');

const files = [
	'deps-audit.json',
	'deps-apps.json',
	'deps-score.json',
	'wit-graph.json',
	'wit-quality-audit.json',
	'wit-quality-improvement-plan.md',
];

await mkdir(targetDir, { recursive: true });

for (const file of files) {
	await cp(path.join(sourceDir, file), path.join(targetDir, file), { force: true });
}

console.log(`Synced deps assets to ${targetDir}`);
