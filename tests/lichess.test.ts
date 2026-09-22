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
import {
	dayBefore,
	dayKey,
	gamesUrlForUser,
	parseNdjson,
	shouldImportGame,
} from '../src/lib/lichess/fetch';
import { managedSection, mergeManagedSection } from '../src/lib/lichess/notes';
import {
	findBestRepertoireMatch,
	gameDate,
	hashString,
	parseGame,
} from '../src/lib/lichess/pgn';
import { LichessGameRecord } from '../src/lib/lichess/types';

const pgn = [
	'[Event "Rated Blitz game"]',
	'[Site "https://lichess.org/abc123"]',
	'[Date "2026.09.20"]',
	'[UTCDate "2026.09.20"]',
	'[White "m42e_de"]',
	'[Black "Opponent"]',
	'[Result "1-0"]',
	'[ECO "C20"]',
	'[TimeControl "300+3"]',
	'[Variant "Standard"]',
	'',
	'1. e4 e5 2. Nf3 Nc6 1-0',
].join('\n');

const rawGame = {
	id: 'abc123',
	createdAt: new Date(2026, 8, 20, 23, 50).getTime(),
	lastMoveAt: new Date(2026, 8, 21, 0, 10).getTime(),
	variant: 'standard',
	speed: 'blitz',
	winner: 'white',
	players: {
		white: { user: { name: 'm42e_de' }, rating: 1542 },
		black: { user: { name: 'Opponent' }, rating: 1510 },
	},
	pgn,
};

describe('Lichess integration', () => {
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
			(member) => member.name?.getText(source) === 'importLichessGames'
		)!;
		const { outputText } = transpileModule(
			`class ImportProbe { ${method.getText(source)} }`,
			{ compilerOptions: { target: ScriptTarget.ES2022 } }
		);
		const importGames = runInNewContext(
			`${outputText}; ImportProbe.prototype.importLichessGames`,
			{
				lichessDayKey: dayKey,
				lichessDayBefore: dayBefore,
				parseLichessGame: parseGame,
				shouldImportLichessGame: shouldImportGame,
				findBestLichessRepertoireMatch: findBestRepertoireMatch,
				console: { info() {}, warn() {}, error() {} },
				Notice: class {},
			}
		) as (this: ImportProbe) => Promise<void>;

		type ImportProbe = {
			importInProgress: boolean;
			settings: {
				lichessUsername: string;
				lichessLastFetchedDay: string;
			};
			fetchLichessGames(): Promise<Record<string, unknown>[]>;
			loadedRepertoires(): Promise<[]>;
			writeLichessBoard(game: LichessGameRecord): void;
			lichessDailyNotePath(): string;
			updateLichessDailyNote(path: string, games: LichessGameRecord[]): void;
			saveSettings(): void;
		};

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
			const plugin: ImportProbe = {
				importInProgress: false,
				settings: {
					lichessUsername: 'm42e_de',
					lichessLastFetchedDay: persistedDay,
				},
				fetchLichessGames() {
					step('fetch');
					return Promise.resolve(failure === 'empty' ? [] : [rawGame]);
				},
				loadedRepertoires() {
					step('load');
					return Promise.resolve([]);
				},
				writeLichessBoard() {
					step('board');
				},
				lichessDailyNotePath: () => '2026-09-21.md',
				updateLichessDailyNote() {
					step('note');
				},
				saveSettings(this: ImportProbe) {
					step('save');
					persistedDay = this.settings.lichessLastFetchedDay;
				},
			};

			await importGames.call(plugin);

			const expectedDay = ['none', 'empty'].includes(failure)
				? dayKey(new Date())
				: '2026-09-01';
			assert.equal(persistedDay, expectedDay, failure);
			assert.equal(plugin.settings.lichessLastFetchedDay, expectedDay, failure);
			assert.equal(plugin.importInProgress, false, failure);
			if (failure === 'none')
				assert.deepEqual(calls, ['fetch', 'load', 'board', 'note', 'save']);
			if (failure === 'empty') assert.deepEqual(calls, ['fetch', 'load', 'save']);
		}
	});

	it('builds a public ND-JSON export URL without Chess.com settings', () => {
		const url = new URL(gamesUrlForUser('test user', '2026-09-20', 123456));

		assert.equal(url.pathname, '/api/games/user/test%20user');
		assert.equal(
			url.searchParams.get('since'),
			String(new Date(2026, 8, 20).getTime())
		);
		assert.equal(url.searchParams.get('until'), '123456');
		assert.equal(url.searchParams.get('max'), '300');
		assert.equal(url.searchParams.get('pgnInJson'), 'true');
	});

	it('caps the first import and paginates checkpointed imports', async () => {
		const source = createSourceFile(
			'main.tsx',
			readFileSync('src/main.tsx', 'utf8'),
			ScriptTarget.Latest,
			true,
			ScriptKind.TSX
		);
		const pluginClass = source.statements.find(isClassDeclaration)!;
		const method = pluginClass.members.find(
			(member) => member.name?.getText(source) === 'fetchLichessGames'
		)!;
		const { outputText } = transpileModule(
			`class FetchProbe { ${method.getText(source)} }`,
			{ compilerOptions: { target: ScriptTarget.ES2022 } }
		);
		const page = Array.from({ length: 300 }, (_, index) => ({
			id: `game-${index}`,
			createdAt: 1000 - index,
		}));
		const requests: string[] = [];
		let responses: Array<{ status: number; text: string }> = [];
		const fetchGames = runInNewContext(
			`${outputText}; FetchProbe.prototype.fetchLichessGames`,
			{
				gamesUrlForUser,
				LICHESS_PAGE_SIZE: 300,
				parseNdjson,
				hashLichessString: hashString,
				requestUrl: ({ url }: { url: string }) => {
					requests.push(url);
					return Promise.resolve(responses.shift()!);
				},
			}
		) as (
			username: string,
			earliestGameDay: string
		) => Promise<Record<string, unknown>[]>;

		const pageText = page.map((game) => JSON.stringify(game)).join('\n');
		responses = [{ status: 200, text: pageText }];
		assert.equal((await fetchGames('m42e_de', '')).length, 300);
		assert.equal(requests.length, 1);

		requests.length = 0;
		responses = [
			{ status: 200, text: pageText },
			{ status: 200, text: JSON.stringify({ id: 'older', createdAt: 500 }) },
		];
		assert.equal((await fetchGames('m42e_de', '2026-09-20')).length, 301);
		assert.equal(requests.length, 2);
		assert.equal(new URL(requests[1]).searchParams.get('until'), '700');
	});

	it('parses Lichess ND-JSON game records', () => {
		assert.deepEqual(parseNdjson(`${JSON.stringify(rawGame)}\n`), [rawGame]);
		assert.throws(() => parseNdjson('{"id":\n'));
	});

	it('uses the completion timestamp and normalises a Lichess game', () => {
		const game = parseGame(rawGame, 'm42e_de');

		assert.ok(game);
		assert.equal(game.date.getTime(), rawGame.lastMoveAt);
		assert.equal(game.playerColor, 'w');
		assert.equal(game.playerResult, 'win');
		assert.equal(game.key, 'https://lichess.org/abc123');
		assert.equal(game.url, 'https://lichess.org/abc123');
		assert.equal(game.analysisUrl, 'https://lichess.org/abc123/analysis');
		assert.equal(game.timeClass, 'blitz');
		assert.equal(game.timeControl, '300+3');
		assert.equal(game.ratings.white, 1542);
		assert.deepEqual(
			game.parsed.moves.map((move) => move.san),
			['e4', 'e5', 'Nf3', 'Nc6']
		);
		assert.equal(shouldImportGame(game.date, '2026-09-21'), true);
	});

	it('falls back from a bad completion timestamp to PGN dates', () => {
		assert.equal(
			gameDate(
				{ lastMoveAt: 'invalid', createdAt: 0 },
				{ UTCDate: '2026.09.20' }
			).getTime(),
			new Date(2026, 8, 20).getTime()
		);
	});

	it('keeps existing imported games when a later import adds games', () => {
		const first = parseGame(rawGame, 'm42e_de')!;
		const second = parseGame(
			{
				...rawGame,
				id: 'def456',
				pgn: pgn.replace('abc123', 'def456').replace('1. e4 e5', '1. d4 d5'),
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

		const merged = mergeManagedSection(existing, [second], settings);

		assert.match(merged, /Personal note.*keep this/);
		assert.equal((merged.match(/^### /gm) || []).length, 2);
		assert.equal(mergeManagedSection(merged, [first, second], settings), merged);
	});
});
