/**
 * Copy the built plugin into an Obsidian vault, for local development.
 *
 * No default path: this repo is public, and a vault path is specific to
 * whoever is running it. Point CHESS_REPERTOIRE_VAULT_PLUGIN_DIR at
 * `<vault>/.obsidian/plugins/chess-repertoire` before running `npm run deploy`.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const target = process.env.CHESS_REPERTOIRE_VAULT_PLUGIN_DIR;

if (!target) {
	console.error(
		'Set CHESS_REPERTOIRE_VAULT_PLUGIN_DIR to <vault>/.obsidian/plugins/chess-repertoire first.'
	);
	process.exit(1);
}

if (!existsSync(target)) {
	console.error(`Target plugin folder does not exist: ${target}`);
	process.exit(1);
}

for (const file of [
	'main.js',
	'styles.css',
	'manifest.json',
	'vendor/stockfish-19-lite-single.wasm',
	'vendor/Copying.txt',
	'vendor/maia3-5m.onnx',
	'vendor/ort-wasm-simd-threaded.mjs',
	'vendor/ort-wasm-simd-threaded.wasm',
	'vendor/maia3-js-LICENSE.txt',
]) {
	const source = file.startsWith('vendor/')
		? join('src/lib/engine', file)
		: file;
	const destination = file.startsWith('vendor/')
		? join(target, file)
		: join(target, file);
	if (!existsSync(source)) {
		console.error(`Missing release asset: ${source}`);
		process.exit(1);
	}
	if (file.startsWith('vendor/')) {
		mkdirSync(join(target, 'vendor'), { recursive: true });
	}
	copyFileSync(source, destination);
	console.log(`Copied ${source} -> ${destination}`);
}

console.log('\nReload the plugin in Obsidian to pick up the changes.');
