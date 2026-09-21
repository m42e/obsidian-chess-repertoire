import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	createSourceFile,
	isClassDeclaration,
	ScriptKind,
	ScriptTarget,
	transpileModule,
} from 'typescript';
import { repertoireForChessComBoard } from '../src/lib/chesscom/board';
import {
	archiveUrlForMonth,
	dayBefore,
	dayKey,
	shouldFetchArchive,
	shouldImportGame,
} from '../src/lib/chesscom/fetch';
import {
	analysisMarkdown,
	annotateRepertoire,
	gameBlockAtCursor,
	managedSection,
	mergeManagedSection,
	pgnFromBlock,
	replaceAnalysis,
} from '../src/lib/chesscom/notes';
import {
	findBestRepertoireMatch,
	gameDate,
	parseGame,
	repertoireFromGame,
	uciLineToSan,
} from '../src/lib/chesscom/pgn';
import {
	canUseStockfishCache,
	combineStockfishReports,
	hasCompleteAccuracy,
} from '../src/lib/engine';
import { StockfishReport } from '../src/lib/engine/types';

const pgn = [
	'[White "m42e_de"]',
	'[Black "Opponent"]',
	'[Result "1-0"]',
	'[Link "https://www.chess.com/game/daily/123"]',
	'',
	'1. e4 e5 2. Nf3 Nc6 1-0',
].join('\n');

const reportFor = (
	game: NonNullable<ReturnType<typeof parseGame>>,
	index: number,
	swingCp: number
): StockfishReport => {
	const move = game.parsed.moves[index];
	const position = (fen: string, turn: 'w' | 'b', scoreText: string) => ({
		fen,
		turn,
		depth: 4,
		score: { type: 'cp' as const, value: 0 },
		scoreText,
		pv: '',
		pvSan: '',
		bestMove: null,
		bestMoveSan: null,
		ponder: null,
	});

	return {
		engine: 'Stockfish 19 Lite WASM',
		depth: 4,
		analyzedPlies: 1,
		totalPlies: game.parsed.moves.length,
		evaluations: [
			{
				index,
				color: move.color,
				san: move.san,
				swingCp,
				before: position(move.before, move.color, '0.20'),
				after: position(move.after, move.color === 'w' ? 'b' : 'w', '-0.30'),
			},
		],
	};
};

describe('Chess.com integration', () => {
	it('advances the checkpoint only after a successful import and leaves failures retryable', async () => {
		const source = createSourceFile(
			'main.tsx',
			readFileSync('src/main.tsx', 'utf8'),
			ScriptTarget.Latest,
			true,
			ScriptKind.TSX
		);
		const pluginClass = source.statements.find(isClassDeclaration)!;
		const method = pluginClass.members.find(
			(member) => member.name?.getText(source) === 'importChessComGames'
		)!;
		const { outputText } = transpileModule(
			`class ImportProbe { ${method.getText(source)} }`,
			{ compilerOptions: { target: ScriptTarget.ES2022 } }
		);
		const importGames = runInNewContext(
			`${outputText}; ImportProbe.prototype.importChessComGames`,
			{
				dayKey,
				dayBefore,
				parseGame,
				shouldImportGame,
				findBestRepertoireMatch,
				console: { info() {}, warn() {}, error() {} },
				Notice: class {},
			}
		) as (this: unknown) => Promise<void>;

		for (const failure of [
			'fetch',
			'load',
			'board',
			'note',
			'save',
			'none',
			'empty',
		]) {
			const calls: string[] = [];
			let persistedDay = '2026-09-01';
			const step = (name: string) => {
				calls.push(name);
				if (name === failure) throw new Error(`Failed ${name}`);
			};
			const plugin = {
				importInProgress: false,
				stockfishCache: new Map<string, StockfishReport>(),
				stockfishKey: () => 'test',
				settings: {
					chessComUsername: 'm42e_de',
					chessComArchiveMonths: 1,
					chessComLastFetchedDay: persistedDay,
				},
				fetchChessComGames() {
					step('fetch');
					return failure === 'empty'
						? []
						: [{ pgn, end_time: new Date(2026, 8, 21, 12).getTime() / 1000 }];
				},
				loadedRepertoires() {
					step('load');
					return [];
				},
				writeChessComBoard: () => step('board'),
				dailyNotePath: () => '2026-09-21.md',
				updateChessComDailyNote: () => step('note'),
				saveSettings() {
					step('save');
					persistedDay = this.settings.chessComLastFetchedDay;
				},
			};

			await importGames.call(plugin);

			const expectedDay = ['none', 'empty'].includes(failure)
				? dayKey(new Date())
				: '2026-09-01';
			assert.equal(persistedDay, expectedDay, failure);
			assert.equal(plugin.settings.chessComLastFetchedDay, expectedDay, failure);
			assert.equal(plugin.importInProgress, false, failure);
			if (failure === 'none')
				assert.deepEqual(calls, ['fetch', 'load', 'board', 'note', 'save']);
			if (failure === 'empty') assert.deepEqual(calls, ['fetch', 'load', 'save']);
		}
	});

	it('imports daily games by completion time rather than their PGN start date', () => {
		const completed = new Date(2026, 8, 21, 0, 30);
		const game = parseGame(
			{
				pgn: `[UTCDate "2026.09.01"]\n[EndDate "2026.09.20"]\n${pgn}`,
				end_time: completed.getTime() / 1000,
			},
			'm42e_de'
		)!;

		assert.equal(game.date.getTime(), completed.getTime());
		assert.equal(dayKey(game.date), '2026-09-21');
		assert.equal(shouldImportGame(game.date, dayBefore('2026-09-20')), true);
	});

	it('uses the completion date from pasted PGNs without an archive timestamp', () => {
		assert.equal(
			dayKey(gameDate({}, { UTCDate: '2026.09.01', EndDate: '2026.09.21' })),
			'2026-09-21'
		);
	});

	it('falls back to the PGN date when the completion timestamp is invalid', () => {
		for (const endTime of [undefined, 0, 'invalid', Infinity]) {
			assert.equal(
				dayKey(gameDate({ end_time: endTime }, { UTCDate: '2026.09.01' })),
				'2026-09-01'
			);
		}
	});

	it('does not reuse a cached report without side accuracy', () => {
		const report = {
			analyzedPlies: 2,
			totalPlies: 2,
			evaluations: [{ color: 'w' }, { color: 'b' }],
		} as StockfishReport;

		assert.equal(hasCompleteAccuracy(report), false);
		assert.equal(
			hasCompleteAccuracy({
				...report,
				whiteAccuracy: 91,
				blackAccuracy: 92,
			}),
			true
		);
	});

	it('does not reuse a cache from a shorter or unfinished report', () => {
		const report = {
			analyzedPlies: 2,
			totalPlies: 4,
			evaluations: [
				{ index: 0, color: 'w' },
				{ index: 1, color: 'b' },
			],
			whiteAccuracy: 91,
			blackAccuracy: 92,
		} as StockfishReport;

		assert.equal(canUseStockfishCache(report, 4), true);
		assert.equal(canUseStockfishCache(report, 5), false);

		const combined = combineStockfishReports(
			report,
			{
				...report,
				analyzedPlies: 1,
				totalPlies: 2,
				evaluations: [{ ...report.evaluations[0], index: 0 }],
			},
			4,
			{}
		);
		assert.equal(combined.analyzedPlies, 3);
		assert.deepEqual(
			combined.evaluations.map((evaluation) => evaluation.index),
			[0, 1, 2]
		);
	});

	it('preserves imported variations and existing Stockfish annotations', () => {
		const game = parseGame(
			{
				pgn: pgn.replace('1. e4 e5', '1. e4 (1. d4 d5) e5 (1... c5)'),
				url: 'https://www.chess.com/game/daily/123',
				rules: 'chess',
			},
			'm42e_de'
		)!;
		const data = repertoireFromGame(game, 'board');
		const move = data.moves[0];
		const report = (depth: number): StockfishReport => ({
			engine: 'Stockfish 19 Lite WASM',
			depth,
			analyzedPlies: 1,
			totalPlies: data.moves.length,
			evaluations: [
				{
					index: 0,
					color: move.color,
					san: move.san,
					swingCp: -42,
					before: {
						fen: move.before,
						turn: move.color,
						depth,
						score: { type: 'cp', value: 20 },
						scoreText: '0.20',
						pv: move.san,
						pvSan: move.san,
						bestMove: null,
						bestMoveSan: null,
						ponder: null,
					},
					after: {
						fen: move.after,
						turn: move.color === 'w' ? 'b' : 'w',
						depth,
						score: { type: 'cp', value: -22 },
						scoreText: '-0.22',
						pv: '',
						pvSan: '',
						bestMove: null,
						bestMoveSan: null,
						ponder: null,
					},
				},
			],
		});

		const first = annotateRepertoire(data, report(4));
		const second = annotateRepertoire(first, report(8));

		assert.equal(first.rootVariants.length, 1);
		assert.equal(first.rootVariants[0].moves[0].san, 'd4');
		assert.equal(first.moves[0].variants[0].moves[0].san, 'c5');
		assert.equal(
			second.moves[0].comment?.content?.[0].content?.[0].text,
			first.moves[0].comment?.content?.[0].content?.[0].text
		);
	});

	it('can apply cumulative reports as analysis advances', () => {
		const game = parseGame(
			{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
			'm42e_de'
		)!;
		const data = repertoireFromGame(game, 'board');
		const firstReport = reportFor(game, 0, -50);
		const secondReport = reportFor(game, 1, 15);
		const partial = annotateRepertoire(data, firstReport);
		const cumulative = annotateRepertoire(data, {
			...secondReport,
			analyzedPlies: 2,
			evaluations: [...firstReport.evaluations, ...secondReport.evaluations],
		});

		assert.match(
			partial.moves[0].comment?.content?.[0].content?.[0].text || '',
			/Stockfish:/
		);
		assert.equal(partial.moves[1].comment, null);
		assert.match(
			cumulative.moves[1].comment?.content?.[0].content?.[0].text || '',
			/Stockfish:/
		);
	});

	it('preserves JSON annotations when a new game adds a divergent line', () => {
		const first = parseGame(
			{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
			'm42e_de'
		)!;
		first.stockfish = reportFor(first, 3, -50);
		const existing = repertoireForChessComBoard(null, first, 'board', '0.0.7');

		const second = parseGame(
			{
				pgn: pgn.replace('daily/123', 'daily/456').replace('Nc6', 'Nf6'),
				url: 'https://www.chess.com/game/daily/456',
				rules: 'chess',
			},
			'm42e_de'
		)!;
		second.stockfish = reportFor(second, 3, 15);
		const merged = repertoireForChessComBoard(existing, second, 'board', '0.0.7');

		const nc6 = merged.moves[3];
		const nf6 = merged.moves[2].variants.find(
			(variant) => variant.moves[0]?.san === 'Nf6'
		)?.moves[0];

		assert.equal(nc6.san, 'Nc6');
		assert.match(nc6.comment?.content?.[0].content?.[0].text || '', /-0\.50/);
		assert.ok(nf6);
		assert.match(nf6.comment?.content?.[0].content?.[0].text || '', /\+0\.15/);
	});

	it('does not fetch days older than the previous fetch day', () => {
		const lastFetchedDay = '2026-09-21';
		const currentMonthArchive = archiveUrlForMonth(
			'test user',
			new Date(2026, 8, 21)
		);

		assert.equal(
			shouldFetchArchive(
				'https://api.chess.com/pub/player/test/games/2026/08',
				lastFetchedDay
			),
			false
		);
		assert.equal(
			shouldFetchArchive(
				'https://api.chess.com/pub/player/test/games/2026/09',
				lastFetchedDay
			),
			true
		);
		assert.equal(
			currentMonthArchive,
			'https://api.chess.com/pub/player/test%20user/games/2026/09'
		);
		assert.equal(
			shouldFetchArchive(currentMonthArchive, dayBefore(lastFetchedDay)),
			true
		);
		assert.equal(shouldImportGame(new Date(2026, 8, 20), lastFetchedDay), false);
		assert.equal(shouldImportGame(new Date(2026, 8, 21), lastFetchedDay), true);
		assert.equal(dayBefore(lastFetchedDay), '2026-09-20');
		assert.equal(
			shouldImportGame(new Date(2026, 8, 20), dayBefore(lastFetchedDay)),
			true
		);
	});

	it('keeps existing imported games when a later import adds games', () => {
		const first = parseGame(
			{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
			'm42e_de'
		)!;
		const second = parseGame(
			{
				pgn: pgn.replace('daily/123', 'daily/456').replace('1. e4 e5', '1. d4 d5'),
				url: 'https://www.chess.com/game/daily/456',
				rules: 'chess',
			},
			'm42e_de'
		)!;
		const settings = {
			includePgn: true,
			includeAnalysis: true,
			includeBoards: false,
		};
		const existing = managedSection([first], settings).replace(
			'- **Result:** 1-0',
			'- **Result:** 1-0\n- **Personal note:** keep this'
		);
		assert.equal(
			existing.split('\n').find((line) => line.startsWith('### ')),
			'### m42e_de vs Opponent - 1-0'
		);

		const merged = mergeManagedSection(existing, [second], settings);

		assert.match(merged, /Personal note.*keep this/);
		assert.equal((merged.match(/^### /gm) || []).length, 2);
		assert.equal(mergeManagedSection(merged, [first, second], settings), merged);
	});

	it('normalises a public Chess.com PGN into the native repertoire move shape', () => {
		const game = parseGame(
			{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
			'm42e_de'
		);

		assert.ok(game);
		assert.equal(game.playerColor, 'w');
		assert.equal(game.playerResult, 'win');
		assert.equal(game.parsed.skipped, 0);
		assert.deepEqual(
			game.parsed.moves.map((move) => move.san),
			['e4', 'e5', 'Nf3', 'Nc6']
		);
		assert.equal(
			game.analysisUrl,
			'https://www.chess.com/analysis/game/daily/123?tab=review'
		);
	});

	it('uses the PGN game link when the archive URL is stale', () => {
		const canonicalUrl = 'https://www.chess.com/game/daily/789';
		const game = parseGame(
			{
				pgn: pgn.replace('https://www.chess.com/game/daily/123', canonicalUrl),
				url: 'https://www.chess.com/game/daily/246444568',
				rules: 'chess',
			},
			'm42e_de'
		);

		assert.ok(game);
		assert.equal(game.url, canonicalUrl);
		assert.equal(game.key, canonicalUrl);
		assert.equal(
			game.analysisUrl,
			'https://www.chess.com/analysis/game/daily/789?tab=review'
		);
	});

	it('recognises Chess.com computer-game links in pasted PGNs', () => {
		const game = parseGame(
			{
				pgn: pgn.replace(
					'https://www.chess.com/game/daily/123',
					'https://www.chess.com/game/computer/123'
				),
				url: 'https://www.chess.com/game/computer/123',
				rules: 'chess',
			},
			'm42e_de'
		);

		assert.ok(game);
		assert.equal(
			game.analysisUrl,
			'https://www.chess.com/analysis/game/computer/123?tab=review'
		);
	});

	it('converts Stockfish UCI output to SAN', () => {
		assert.equal(
			uciLineToSan(
				'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
				'e2e4 e7e5 g1f3 b8c6 f1b5'
			),
			'e4 e5 Nf3 Nc6 Bb5'
		);
	});

	it('selects and replaces only the game under the cursor', () => {
		const section = managedSection(
			[
				parseGame(
					{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
					'm42e_de'
				)!,
			],
			{ includePgn: true, includeAnalysis: true, includeBoards: false }
		);
		const content = `before\n${section}\nafter`;
		const cursorLine = content
			.split('\n')
			.findIndex((line) => line.startsWith('### '));
		const block = gameBlockAtCursor(content, cursorLine + 2);

		assert.ok(block);
		assert.equal(pgnFromBlock(block.text)?.includes('1. e4 e5'), true);
		const replaced = replaceAnalysis(block.text, '- **Analysis:** selected');
		assert.equal(replaced.includes('- **Analysis:** selected'), true);
		assert.equal(replaced.includes('1. e4 e5'), true);
	});

	it('renders a local Stockfish report as a collapsible review', () => {
		const game = parseGame(
			{ pgn, url: 'https://www.chess.com/game/daily/123', rules: 'chess' },
			'm42e_de'
		)!;
		game.stockfish = {
			engine: 'Stockfish 19 Lite WASM',
			depth: 4,
			analyzedPlies: 1,
			totalPlies: 4,
			evaluations: [
				{
					index: 0,
					color: 'w',
					san: 'e4',
					swingCp: -42,
					before: {
						fen: game.parsed.moves[0].before,
						turn: 'w',
						depth: 4,
						score: { type: 'cp', value: 20 },
						scoreText: '0.20',
						pv: 'e2e4',
						pvSan: 'e4',
						bestMove: 'e2e4',
						bestMoveSan: 'e4',
						ponder: null,
					},
					after: {
						fen: game.parsed.moves[0].after,
						turn: 'b',
						depth: 4,
						score: { type: 'cp', value: -22 },
						scoreText: '-0.22',
						pv: 'e7e5',
						pvSan: 'e5',
						bestMove: 'e7e5',
						bestMoveSan: 'e5',
						ponder: null,
					},
				},
			],
		};

		const markdown = analysisMarkdown(game);
		assert.equal(markdown.includes('Stockfish move review'), true);
		assert.equal(markdown.includes('largest swing -0.42'), true);
	});
});
