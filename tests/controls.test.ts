import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('repertoire controls', () => {
	it('exposes the Stockfish analyze action in the move command bar', () => {
		const source = readFileSync(
			'src/components/react/PgnViewer/Controls/index.tsx',
			'utf8'
		);
		assert.match(source, /onAnalyzeButtonClick/);
		assert.match(source, /Analyze with Stockfish/);
		assert.match(source, /props\.isTraining \|\| props\.isAnalyzing/);
	});

	it('exposes the Stockfish play action in the move command bar', () => {
		const source = readFileSync(
			'src/components/react/PgnViewer/Controls/index.tsx',
			'utf8'
		);
		assert.match(source, /onComputerButtonClick/);
		assert.match(source, /Play against Stockfish from this position/);
		assert.match(source, /!props\.isStockfishEnabled/);
		assert.match(source, /isComputerPlaying/);
	});
});
