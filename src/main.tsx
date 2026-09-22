import { Chess } from 'chess.js';
import {
	App,
	Editor,
	Notice,
	Plugin,
	normalizePath,
	requestUrl,
} from 'obsidian';
import {
	CURRENT_DRILL_VERSION,
	CURRENT_STORAGE_VERSION,
	ChessRepertoireDataAdapter,
	ChessRepertoireFileData,
} from 'src/lib/storage';
import {
	CURRENT_DATA_VERSION,
	moveStorageFiles,
	runMigrations,
} from 'src/lib/storage/migration';
import { PositionView } from './components/PositionView';
import { ReactView } from './components/ReactView';
import { ChessStringModal } from './components/obsidian/ChessStringModal';
import { ConfirmModal } from './components/obsidian/ConfirmModal';
import {
	ChessRepertoirePluginSettings,
	DEFAULT_SETTINGS,
	DEFAULT_STORAGE_FOLDER,
	SettingsTab,
} from './components/obsidian/SettingsTab';

// these styles must be imported somewhere
import 'assets/board/themes.css';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.cburnett.css';
import { nanoid } from 'nanoid';
import { findCodeBlocks } from './lib/blocks';
import { repertoireForChessComBoard } from './lib/chesscom/board';
import {
	archiveUrlForMonth,
	dayBefore,
	dayKey,
	shouldFetchArchive,
	shouldImportGame,
} from './lib/chesscom/fetch';
import {
	END_MARKER,
	START_MARKER,
	analysisMarkdown,
	annotateRepertoire,
	gameBlockAtCursor,
	managedSection,
	mergeManagedSection,
	pgnFromBlock,
	replaceAnalysis,
} from './lib/chesscom/notes';
import {
	findBestRepertoireMatch,
	hashString,
	parseGame,
	parseHeaders,
} from './lib/chesscom/pgn';
import { ChessComGameRecord } from './lib/chesscom/types';
import {
	UnusedRepertoire,
	UnusedScan,
	findUnusedRepertoires,
	isInSearchFolder,
	isSearchableNote,
	unusedFileCount,
	unusedFileLines,
} from './lib/cleanup';
import {
	StockfishAnalysisCancelled,
	StockfishAnalyzer,
	canUseStockfishCache,
	combineStockfishReports,
} from './lib/engine';
import { StockfishReport } from './lib/engine/types';
import { Maia3Player } from './lib/maia3';
import { handleRepertoireKey, releaseOnOutsideClick } from './lib/keyboard';
import { chessRepertoireKeymap } from './lib/keyboard/extension';
import { mergeDrillStats, mergeRepertoires } from './lib/merge';
import { parseUserConfig } from './lib/obsidian';
import { looksLikeFen, parsePgn, titleFromHeaders } from './lib/pgn';
import { parsePositionConfig } from './lib/position';
import './main.css';

/** Either a position (FEN) or a game (PGN); `looksLikeFen` tells them apart. */
export type ChessString = string;

export const ROOT_FEN =
	'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// TODO:
// 1) Allow to show the root position
// 2) Display correct move after removing the last move

/** What a merge did, in one line. */
const mergeNotice = (merged: number, skipped: number): string =>
	[
		`Merged ${merged} repertoires into a new one.`,
		skipped &&
			`${skipped} ${
				skipped === 1 ? 'repertoire starts' : 'repertoires start'
			} from another position and ${skipped === 1 ? 'was' : 'were'} left out.`,
	]
		.filter(Boolean)
		.join(' ');

/** `2 files`, `1 file`. */
const plural = (count: number, one: string, many: string): string =>
	`${count} ${count === 1 ? one : many}`;

export default class ChessRepertoirePlugin extends Plugin {
	settings: ChessRepertoirePluginSettings;
	dataAdapter: ChessRepertoireDataAdapter;
	private stockfishAnalyzer: StockfishAnalyzer | null = null;
	private maia3Player: Maia3Player | null = null;
	private stockfishCache = new Map<
		string,
		import('./lib/engine/types').StockfishReport
	>();
	private stockfishStatusBarItem: HTMLElement | null = null;
	private stockfishAnalysisActive = false;
	private stockfishAnalysisRun = 0;
	private stockfishCancellationRequested = false;
	private importInProgress = false;

	private registerChessComCommands() {
		this.addCommand({
			id: 'import-chess-com-games',
			name: 'Import Chess.com games into daily notes',
			callback: () => void this.importChessComGames(),
		});
		this.addCommand({
			id: 'import-chess-com-pgn',
			name: 'Import Chess.com PGN into daily notes',
			callback: () =>
				new ChessStringModal(
					this.app,
					(pgn) => void this.importChessComPgn(pgn)
				).open(),
		});
		this.addCommand({
			id: 'analyze-chess-com-game-under-cursor',
			name: 'Analyze Chess.com game under cursor',
			editorCallback: (editor: Editor) =>
				void this.analyzeChessComGameUnderCursor(editor),
		});
		this.addCommand({
			id: 'clear-chess-com-stockfish-cache',
			name: 'Clear cached Chess.com Stockfish analyses',
			callback: async () => {
				this.settings.stockfishCache = {};
				this.stockfishCache.clear();
				await this.saveSettings();
				new Notice('Cached Chess.com Stockfish analyses cleared.');
			},
		});
	}

	private async fetchChessComJson(
		url: string
	): Promise<Record<string, unknown>> {
		const response = await requestUrl({
			url,
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Obsidian Chess Repertoire',
			},
		});
		if (response.status >= 400)
			throw new Error(`Chess.com returned HTTP ${response.status}`);
		return response.json as Record<string, unknown>;
	}

	private async fetchChessComGames(
		username: string,
		earliestGameDay: string
	): Promise<Record<string, unknown>[]> {
		const archives = await this.fetchChessComJson(
			`https://api.chess.com/pub/player/${encodeURIComponent(
				username
			)}/games/archives`
		);
		const listedArchives = Array.isArray(archives.archives)
			? archives.archives.map(String)
			: [];
		const currentMonthArchive = archiveUrlForMonth(username, new Date());
		const urls = Array.from(
			new Set([
				...listedArchives
					.slice(-Math.min(24, Math.max(1, this.settings.chessComArchiveMonths)))
					.filter((archive) => shouldFetchArchive(archive, earliestGameDay)),
				currentMonthArchive,
			])
		).filter((archive) => shouldFetchArchive(archive, earliestGameDay));
		console.info('chess-repertoire: Chess.com archives selected', {
			username,
			earliestGameDay,
			availableArchives: listedArchives.length,
			currentMonthArchive,
			selectedArchives: urls,
		});
		const games: Record<string, unknown>[] = [];
		for (const archive of urls) {
			const result = await this.fetchChessComJson(String(archive));
			if (Array.isArray(result.games))
				games.push(...(result.games as Record<string, unknown>[]));
		}
		return games;
	}

	private dailyNotePath(date: Date): string {
		const dailyNotes = (
			this.app as App & {
				internalPlugins?: { getPluginById(id: string): unknown };
			}
		).internalPlugins?.getPluginById('daily-notes') as
			| { instance?: { options?: { folder?: string; format?: string } } }
			| undefined;
		const options = dailyNotes?.instance?.options || {};
		const folder = normalizePath(
			this.settings.chessComDailyNotesFolder.trim() || options.folder || ''
		);
		const format =
			this.settings.chessComDailyNoteFormat.trim() ||
			options.format ||
			'YYYY-MM-DD';
		const values: Record<string, string> = {
			YYYY: String(date.getFullYear()).padStart(4, '0'),
			MM: String(date.getMonth() + 1).padStart(2, '0'),
			DD: String(date.getDate()).padStart(2, '0'),
		};
		const filename = format.replace(/YYYY|MM|DD/g, (token) => values[token]);
		return normalizePath(`${folder ? `${folder}/` : ''}${filename}.md`);
	}

	private async ensureChessComFolder(path: string): Promise<void> {
		let current = '';
		for (const part of normalizePath(path).split('/')) {
			if (!part) continue;
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				try {
					await this.app.vault.adapter.mkdir(current);
				} catch (error) {
					if (
						!(await this.app.vault.adapter.exists(current)) &&
						!/already exists/i.test(String(error))
					)
						throw error;
				}
			}
		}
	}

	private async loadedRepertoires(): Promise<
		Array<{ id: string; repertoire: ChessRepertoireFileData }>
	> {
		const files = await this.app.vault.adapter.list(this.storagePath);
		const entries: Array<{ id: string; repertoire: ChessRepertoireFileData }> =
			[];
		for (const path of files.files.filter(
			(file) => file.endsWith('.json') && !file.endsWith('.drill.json')
		)) {
			try {
				const id = path
					.split('/')
					.pop()!
					.replace(/\.json$/, '');
				entries.push({ id, repertoire: await this.dataAdapter.loadFile(id) });
			} catch (error) {
				console.debug(`chess-repertoire: skipped ${path}`, error);
			}
		}
		return entries;
	}

	private stockfishKey(game: ChessComGameRecord): string {
		return `${game.key}:${this.settings.stockfishDepth}:${this.settings.stockfishMaxPlies}`;
	}

	private ensureStockfishStatusBarItem(): HTMLElement {
		if (this.stockfishStatusBarItem) return this.stockfishStatusBarItem;

		const item = this.addStatusBarItem();
		this.registerDomEvent(item, 'click', () => {
			if (!this.stockfishAnalysisActive) return;
			const run = this.stockfishAnalysisRun;
			new ConfirmModal(this.app, {
				title: 'Cancel Stockfish analysis?',
				body:
					'Stockfish is still analyzing this game. Completed move annotations are already saved; only the current move will be incomplete.',
				confirmText: 'Cancel analysis',
				onConfirm: () => {
					if (!this.stockfishAnalysisActive || this.stockfishAnalysisRun !== run)
						return;
					this.stockfishCancellationRequested = true;
					const analyzer = this.stockfishAnalyzer;
					analyzer?.cancel();
					if (this.stockfishAnalyzer === analyzer) this.stockfishAnalyzer = null;
				},
			}).open();
		});
		this.stockfishStatusBarItem = item;
		return item;
	}

	private startStockfishAnalysis(): number {
		const run = ++this.stockfishAnalysisRun;
		this.stockfishAnalysisActive = true;
		this.stockfishCancellationRequested = false;
		const item = this.ensureStockfishStatusBarItem();
		item.classList.add('mod-clickable');
		item.setAttribute('aria-label', 'Click to cancel Stockfish analysis');
		item.setAttribute('title', 'Click to cancel Stockfish analysis');
		item.setText('Stockfish analysis: starting...');
		return run;
	}

	private finishStockfishAnalysis(run: number): void {
		if (this.stockfishAnalysisRun !== run) return;
		this.stockfishAnalysisActive = false;
		this.stockfishCancellationRequested = false;
		this.stockfishStatusBarItem?.setText('');
		this.stockfishStatusBarItem?.classList.remove('mod-clickable');
		this.stockfishStatusBarItem?.removeAttribute('aria-label');
		this.stockfishStatusBarItem?.removeAttribute('title');
	}

	private async loadStockfish(): Promise<StockfishAnalyzer> {
		if (this.stockfishAnalyzer) return this.stockfishAnalyzer;
		const candidates = [
			normalizePath(`${this.manifest.dir}/vendor/stockfish-19-lite-single.wasm`),
			normalizePath(`${this.manifest.dir}/stockfish-19-lite-single.wasm`),
		];
		let binary: ArrayBuffer | null = null;
		for (const path of candidates) {
			if (await this.app.vault.adapter.exists(path)) {
				binary = await this.app.vault.adapter.readBinary(path);
				break;
			}
		}
		if (!binary)
			throw new Error('Stockfish WASM asset is missing from the plugin folder.');
		if (this.stockfishCancellationRequested)
			throw new StockfishAnalysisCancelled();
		const analyzer = new StockfishAnalyzer(
			binary,
			this.settings.stockfishDepth,
			(completed, total) => {
				this.stockfishStatusBarItem?.setText(
					`Stockfish analysis: ${completed}/${total} positions`
				);
			}
		);
		this.stockfishAnalyzer = analyzer;
		if (this.stockfishCancellationRequested) {
			analyzer.cancel();
			this.stockfishAnalyzer = null;
			throw new StockfishAnalysisCancelled();
		}
		return analyzer;
	}

	private async bestStockfishMove(fen: string): Promise<string | null> {
		if (!this.settings.stockfishEnabled) {
			new Notice('Enable local Stockfish in Chess Repertoire settings first.');
			return null;
		}

		try {
			return await (
				await this.loadStockfish()
			).bestMove(fen, this.settings.stockfishPlayElo);
		} catch (error) {
			new Notice(`Stockfish move failed: ${String(error)}`, 0);
			return null;
		}
	}

	private maia3WasmPaths(): string | undefined {
		const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
			getResourcePath?: (path: string) => string;
		};
		const resourcePath = adapter.getResourcePath?.(
			normalizePath(`${this.manifest.dir}/vendor`)
		);

		return resourcePath ? `${resourcePath.replace(/\/+$/, '')}/` : undefined;
	}

	private async loadMaia3(): Promise<Maia3Player> {
		if (this.maia3Player) return this.maia3Player;

		const candidates = [
			normalizePath(`${this.manifest.dir}/vendor/maia3-5m.onnx`),
			normalizePath(`${this.manifest.dir}/maia3-5m.onnx`),
		];
		let binary: ArrayBuffer | null = null;
		for (const path of candidates) {
			if (await this.app.vault.adapter.exists(path)) {
				binary = await this.app.vault.adapter.readBinary(path);
				break;
			}
		}
		if (!binary)
			throw new Error('Maia3 ONNX model is missing from the plugin folder.');

		const player = new Maia3Player(binary, this.maia3WasmPaths());
		this.maia3Player = player;
		return player;
	}

	private async bestMaia3Move(fen: string): Promise<string | null> {
		if (!this.settings.maia3Enabled) {
			new Notice('Enable local Maia3 in Chess Repertoire settings first.');
			return null;
		}

		try {
			return await (
				await this.loadMaia3()
			).bestMove(fen, this.settings.maia3PlayElo);
		} catch (error) {
			new Notice(`Maia3 move failed: ${String(error)}`, 0);
			return null;
		}
	}

	private async bestComputerMove(fen: string): Promise<string | null> {
		return this.settings.computerEngine === 'maia3'
			? this.bestMaia3Move(fen)
			: this.bestStockfishMove(fen);
	}

	private async analyzeChessComGame(
		game: ChessComGameRecord,
		onReport?: (report: StockfishReport) => void | Promise<void>
	): Promise<void> {
		const key = this.stockfishKey(game);
		const cached = this.stockfishCache.get(key);
		const previous =
			cached && canUseStockfishCache(cached, game.parsed.moves.length)
				? cached
				: null;
		if (previous && previous.analyzedPlies >= game.parsed.moves.length) {
			game.stockfish = previous;
			await onReport?.(previous);
			return;
		}
		if (!this.settings.stockfishEnabled) {
			new Notice('Enable local Stockfish in Chess Repertoire settings first.');
			return;
		}
		const run = this.startStockfishAnalysis();
		try {
			const startPly = previous?.analyzedPlies ?? 0;
			const remainingMoves = game.parsed.moves.slice(startPly);
			const publish = async (partial: StockfishReport) => {
				const report = combineStockfishReports(
					previous,
					partial,
					game.parsed.moves.length,
					game.ratings
				);
				this.stockfishCache.set(key, report);
				await onReport?.(report);
			};
			const report = await (
				await this.loadStockfish()
			).analyze(
				remainingMoves,
				this.settings.stockfishMaxPlies,
				game.ratings,
				publish
			);
			game.stockfish = combineStockfishReports(
				previous,
				report,
				game.parsed.moves.length,
				game.ratings
			);
			this.stockfishCache.set(key, game.stockfish);
			this.settings.stockfishCache = Object.fromEntries(this.stockfishCache);
			await this.saveSettings();
		} catch (error) {
			if (error instanceof StockfishAnalysisCancelled) {
				game.stockfish = undefined;
				return;
			}
			game.stockfishError = String(error);
			new Notice(`Selected-game analysis failed: ${game.stockfishError}`, 0);
		} finally {
			this.finishStockfishAnalysis(run);
		}
	}

	async analyzeRepertoire(
		id: string,
		data: ChessRepertoireFileData,
		onUpdate?: (data: ChessRepertoireFileData) => void
	): Promise<ChessRepertoireFileData | null> {
		if (!this.settings.stockfishEnabled) {
			new Notice('Enable local Stockfish in Chess Repertoire settings first.');
			return null;
		}
		if (!data.moves.length) {
			new Notice('There are no moves to analyze in this repertoire.');
			return null;
		}
		const pseudoGame = parseGame(
			{
				pgn: data.moves.map((move) => move.san).join(' '),
				rules: 'chess',
			},
			this.settings.chessComUsername
		);
		if (!pseudoGame) return null;
		pseudoGame.parsed.moves = data.moves;
		let annotated = data;
		await this.analyzeChessComGame(pseudoGame, async (report) => {
			annotated = annotateRepertoire(data, report);
			await this.dataAdapter.saveFile(annotated, id);
			onUpdate?.(annotated);
		});
		if (!pseudoGame.stockfish) return null;
		annotated = annotateRepertoire(data, pseudoGame.stockfish);
		await this.dataAdapter.saveFile(annotated, id);
		onUpdate?.(annotated);
		new Notice(
			`Stockfish accuracy: White ${
				pseudoGame.stockfish.whiteAccuracy?.toFixed(1) ?? 'n/a'
			}%, Black ${pseudoGame.stockfish.blackAccuracy?.toFixed(1) ?? 'n/a'}%.`
		);
		return annotated;
	}

	private async writeChessComBoard(
		game: ChessComGameRecord,
		existingId?: string
	): Promise<void> {
		if (
			(!this.settings.chessComIncludeBoards && !existingId) ||
			game.rules !== 'chess'
		)
			return;
		const id = existingId || `chesscom-${hashString(game.key)}`;
		const path = normalizePath(`${this.dataAdapter.storagePath}/${id}.json`);
		const exists = await this.dataAdapter.adapter.exists(path);
		if (exists && !existingId) {
			game.boardId = id;
			return;
		}
		const existing = exists ? await this.dataAdapter.loadFile(id) : null;
		const data = repertoireForChessComBoard(
			existing,
			game,
			id,
			CURRENT_STORAGE_VERSION
		);
		await this.dataAdapter.createStorageFolderIfNotExists();
		await this.dataAdapter.saveFile(data, id);
		game.boardId = id;
	}

	private gameAnalysisLine(game: ChessComGameRecord): string {
		return analysisMarkdown(game);
	}

	private async updateChessComDailyNote(
		path: string,
		games: ChessComGameRecord[]
	): Promise<void> {
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (folder) await this.ensureChessComFolder(folder);
		const existing = this.app.vault.getAbstractFileByPath(path);
		const settings = {
			includePgn: this.settings.chessComIncludePgn,
			includeAnalysis: this.settings.chessComIncludeAnalysis,
			includeBoards: this.settings.chessComIncludeBoards,
		};
		if (existing && 'extension' in existing && existing.extension === 'md') {
			const content = await this.app.vault.cachedRead(
				existing as import('obsidian').TFile
			);
			const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`);
			const next = pattern.test(content)
				? content.replace(pattern, (section) =>
						mergeManagedSection(section, games, settings)
				  )
				: `${content.trimEnd()}${content.trimEnd() ? '\n\n' : ''}${managedSection(
						games,
						settings
				  )}\n`;
			if (next !== content)
				await this.app.vault.modify(existing as import('obsidian').TFile, next);
		} else {
			await this.app.vault.create(path, `${managedSection(games, settings)}\n`);
		}
	}

	private async importChessComGames(): Promise<void> {
		if (this.importInProgress) return;
		const username = this.settings.chessComUsername.trim();
		if (!username) {
			new Notice('Set a Chess.com username in Chess Repertoire settings.');
			return;
		}
		this.importInProgress = true;
		const lastFetchedDay = this.settings.chessComLastFetchedDay;
		try {
			const importDay = dayKey(new Date());
			const importFromDay = dayBefore(lastFetchedDay);
			console.info('chess-repertoire: Chess.com import started', {
				username,
				lastFetchedDay,
				importFromDay,
				archiveMonths: this.settings.chessComArchiveMonths,
			});
			const rawGames = await this.fetchChessComGames(username, importFromDay);
			const entries = await this.loadedRepertoires();
			const games: ChessComGameRecord[] = [];
			const seen = new Set<string>();
			let unparseable = 0;
			let olderThanWindow = 0;
			let duplicates = 0;
			for (const raw of rawGames) {
				const game = parseGame(raw, username);
				if (!game) {
					unparseable += 1;
					continue;
				}
				if (!shouldImportGame(game.date, importFromDay)) {
					olderThanWindow += 1;
					continue;
				}
				if (seen.has(game.key)) {
					duplicates += 1;
					continue;
				}
				seen.add(game.key);
				const cached = this.stockfishCache.get(this.stockfishKey(game));
				if (cached) game.stockfish = cached;
				game.repertoireMatch =
					findBestRepertoireMatch(game.parsed.moves, entries) || undefined;
				await this.writeChessComBoard(game);
				games.push(game);
			}
			console.info('chess-repertoire: Chess.com games fetched', {
				rawGames: rawGames.length,
				eligibleGames: games.length,
				unparseable,
				olderThanWindow,
				duplicates,
			});
			const grouped = new Map<string, ChessComGameRecord[]>();
			for (const game of games) {
				const path = this.dailyNotePath(game.date);
				grouped.set(path, [...(grouped.get(path) || []), game]);
			}
			for (const [path, groupedGames] of grouped)
				await this.updateChessComDailyNote(path, groupedGames);
			this.settings.chessComLastFetchedDay = importDay;
			await this.saveSettings();
			if (!games.length) {
				console.warn(
					'chess-repertoire: Chess.com returned no games in the import window'
				);
				new Notice(`No games found for ${username}.`);
				return;
			}
			new Notice(
				`Imported ${games.length} Chess.com ${
					games.length === 1 ? 'game' : 'games'
				}.`
			);
		} catch (error) {
			this.settings.chessComLastFetchedDay = lastFetchedDay;
			console.error('chess-repertoire: Chess.com import failed', error);
			new Notice(`Chess.com import failed: ${String(error)}`, 0);
		} finally {
			this.importInProgress = false;
		}
	}

	private async importChessComPgn(pgn: string): Promise<void> {
		if (this.importInProgress) return;
		const username = this.settings.chessComUsername.trim();
		if (!username) {
			new Notice('Set a Chess.com username in Chess Repertoire settings.');
			return;
		}

		const trimmed = pgn.trim();
		if (!trimmed) {
			new Notice('Paste a Chess.com PGN to import.');
			return;
		}

		this.importInProgress = true;
		try {
			const headers = parseHeaders(trimmed);
			const game = parseGame(
				{
					pgn: trimmed,
					url: headers.Link || `pgn-${hashString(trimmed)}`,
					rules: headers.Variant || 'chess',
				},
				username
			);
			if (!game || !game.parsed.moves.length) {
				new Notice('The pasted Chess.com PGN could not be parsed.');
				return;
			}

			const entries = await this.loadedRepertoires();
			game.repertoireMatch =
				findBestRepertoireMatch(game.parsed.moves, entries) || undefined;
			const cached = this.stockfishCache.get(this.stockfishKey(game));
			if (cached) game.stockfish = cached;
			await this.writeChessComBoard(game);
			await this.updateChessComDailyNote(this.dailyNotePath(game.date), [game]);
			new Notice(`Imported ${game.white} vs ${game.black} into the daily note.`);
		} catch (error) {
			console.error('chess-repertoire: Chess.com PGN import failed', error);
			new Notice(`Chess.com PGN import failed: ${String(error)}`, 0);
		} finally {
			this.importInProgress = false;
		}
	}

	private async analyzeChessComGameUnderCursor(editor: Editor): Promise<void> {
		if (!this.settings.stockfishEnabled) {
			new Notice('Enable local Stockfish in Chess Repertoire settings first.');
			return;
		}
		const cursor = editor.getCursor();
		const block = gameBlockAtCursor(editor.getValue(), cursor.line);
		if (!block) {
			new Notice('Place the cursor inside an imported Chess.com game.');
			return;
		}
		const pgn = pgnFromBlock(block.text);
		if (!pgn) {
			new Notice('The selected game has no embedded PGN.');
			return;
		}
		const headers = parseHeaders(pgn);
		const game = parseGame(
			{ pgn, url: headers.Link || 'selected-game', rules: 'chess' },
			this.settings.chessComUsername
		);
		if (!game || game.parsed.skipped || !game.parsed.moves.length) {
			new Notice('The selected game could not be parsed.');
			return;
		}
		const entries = await this.loadedRepertoires();
		game.repertoireMatch =
			findBestRepertoireMatch(game.parsed.moves, entries) || undefined;
		await this.analyzeChessComGame(game);
		if (!game.stockfish) return;
		const boardId = block.text.match(/chessRepertoireId:\s*([^\s`]+)/)?.[1];
		await this.writeChessComBoard(game, boardId);
		const current = gameBlockAtCursor(editor.getValue(), cursor.line);
		if (!current) throw new Error('The note changed while analysis was running.');
		const replacement = replaceAnalysis(
			current.text,
			this.gameAnalysisLine(game)
		);
		const lines = editor.getValue().split('\n');
		editor.setValue(
			lines
				.slice(0, current.startLine)
				.concat(replacement.split('\n'), lines.slice(current.endLine))
				.join('\n')
		);
		new Notice(`Analyzed ${game.white} vs ${game.black} with Stockfish.`);
	}

	/**
	 * The folder repertoires are read from and written to.
	 *
	 * A getter rather than a field: the folder is a setting now, and the value is
	 * wanted again every time it changes. Empty falls back to the default, which
	 * is what every vault upgrading from 1.2.0 or earlier will have.
	 */
	get storagePath(): string {
		return normalizePath(
			this.settings.storageFolder.trim() || DEFAULT_STORAGE_FOLDER
		);
	}

	/**
	 * Where the repertoires actually are, as opposed to where the setting now
	 * says they should be.
	 *
	 * The two come apart while the setting is being edited, and the move has to
	 * start from the folder holding the files rather than from whatever the
	 * setting said a moment ago - otherwise a run of edits leaves them behind in
	 * the first folder and moves nothing out of the ones in between.
	 */
	private settledStoragePath: string;

	async onload() {
		// Load Settings
		await this.loadSettings();
		this.stockfishCache = new Map(
			Object.entries(this.settings.stockfishCache || {})
		);

		// Register Data Adapter
		this.dataAdapter = new ChessRepertoireDataAdapter(
			this.app.vault.adapter,
			this.storagePath
		);

		this.settledStoragePath = this.storagePath;

		await this.dataAdapter.createStorageFolderIfNotExists();

		await this.runMigrations();

		// Add settings tab
		this.addSettingTab(new SettingsTab(this.app, this));
		this.registerChessComCommands();

		if (this.settings.chessComImportOnStartup)
			this.app.workspace.onLayoutReady(() => void this.importChessComGames());

		// Add command
		this.addCommand({
			// Obsidian namespaces this as `chess-repertoire:insert-chess-repertoire`,
			// so the plugin's name is in there twice. Renaming it would clear the
			// review's warning and silently drop everyone's hotkey for it, which is
			// the worse of the two.
			id: 'insert-chess-repertoire',
			name: 'Insert FEN/PGN editor at cursor position',
			editorCallback: (editor: Editor) => {
				const cursorPosition = editor.getCursor();

				const onSubmit = async (chessString: ChessString | undefined) => {
					try {
						const chessStringTrimmed = chessString?.trim() ?? '';

						const isFen = looksLikeFen(chessStringTrimmed);

						// Validates it, and throws for the notice below if it is not a
						// position after all.
						if (isFen) new Chess(chessStringTrimmed);

						const parsed = isFen
							? null
							: parsePgn(chessStringTrimmed, ROOT_FEN, nanoid);

						if (parsed?.skipped) {
							new Notice(
								`${parsed.skipped} ${
									parsed.skipped === 1 ? 'move' : 'moves'
								} in that PGN could not be read and were left out.`
							);
						}

						const chessRepertoireFileData: ChessRepertoireFileData = {
							version: CURRENT_STORAGE_VERSION,
							header: {
								title: parsed ? titleFromHeaders(parsed.headers) : null,
							},
							moves: parsed?.moves ?? [],
							rootVariants: parsed?.rootVariants ?? [],
							rootFEN: isFen ? chessStringTrimmed : parsed?.rootFEN ?? ROOT_FEN,
						};

						await this.dataAdapter.createStorageFolderIfNotExists();

						const id = await this.dataAdapter.saveFile(chessRepertoireFileData);

						editor.replaceRange(
							`\`\`\`chessRepertoire\nchessRepertoireId: ${id}\n\`\`\``,
							cursorPosition
						);
					} catch (e) {
						console.error('chess-repertoire: could not parse the input', e);
						new Notice('There was an error during PGN parsing.', 0);
					}
				};

				new ChessStringModal(
					this.app,
					(chessString) => void onSubmit(chessString)
				).open();
			},
		});

		// Combine every repertoire in a note into one
		this.addCommand({
			// Kept for the same reason as the id above.
			id: 'merge-chess-repertoires',
			name: 'Merge every repertoire in this note into one',
			editorCallback: async (editor: Editor) => {
				const cursorPosition = editor.getCursor();
				const ids = this.repertoireIdsIn(editor.getValue());

				if (ids.length < 2) {
					new Notice(
						'This note needs at least two chess repertoires before there is anything to merge.'
					);

					return;
				}

				try {
					const repertoires = await Promise.all(
						ids.map((id) => this.dataAdapter.loadFile(id))
					);

					const { repertoire, skipped } = mergeRepertoires(
						repertoires,
						CURRENT_STORAGE_VERSION
					);

					const mergedId = await this.dataAdapter.saveFile(repertoire);

					// The merged repertoire keeps every move id, so the drills already done
					// against the originals still name real moves.
					const stats = mergeDrillStats(
						await Promise.all(ids.map((id) => this.dataAdapter.loadDrillData(id)))
					);

					if (Object.keys(stats).length)
						await this.dataAdapter.saveDrillData(mergedId, {
							version: CURRENT_DRILL_VERSION,
							stats,
						});

					// At the cursor, leaving the repertoires it was built from alone: a
					// merge is not a decision to throw the originals away.
					editor.replaceRange(
						`\`\`\`chessRepertoire\nchessRepertoireId: ${mergedId}\n\`\`\``,
						cursorPosition
					);

					new Notice(mergeNotice(ids.length - skipped, skipped));
				} catch (e) {
					console.error(
						'chess-repertoire: could not merge the repertoires in this note',
						e
					);
					new Notice(
						'There was an error while merging the repertoires in this note.',
						0
					);
				}
			},
		});

		this.registerRepertoireKeyboard();

		this.registerPositionBlock();

		// Add chess repertoire code block processor
		this.registerMarkdownCodeBlockProcessor(
			'chessRepertoire',
			async (source, el, ctx) => {
				const { chessRepertoireId } = parseUserConfig(this.settings, source);

				if (!chessRepertoireId.trim().length)
					return new Notice(
						"No chessRepertoireId parameter found, please add one manually if the file already exists or add it via the 'Insert FEN/PGN editor at cursor position' command.",
						0
					);

				try {
					const data = await this.dataAdapter.loadFile(chessRepertoireId);

					ctx.addChild(
						new ReactView(
							el,
							source,
							this.app,
							ctx,
							this.settings,
							data,
							this.dataAdapter,
							(id, repertoire, onUpdate) =>
								this.analyzeRepertoire(id, repertoire, onUpdate),
							(fen) => this.bestComputerMove(fen)
						)
					);
				} catch {
					new Notice(
						`There was an error while trying to load ${chessRepertoireId}.json. You can check the plugin folder if the file exist and if not add one via the 'Insert FEN/PGN editor at cursor position' command.`,
						0
					);
				}
			}
		);
	}

	onunload() {
		this.stockfishAnalyzer?.shutdown();
		this.stockfishAnalyzer = null;
		void this.maia3Player?.shutdown();
		this.maia3Player = null;
		this.stockfishStatusBarItem = null;
	}

	/**
	 * Offers to trash every file in the storage folder that no note refers to.
	 *
	 * A repertoire's file is written the moment the board is made, before its
	 * block reaches the note, and nothing takes it away again: a board thought
	 * better of, a note deleted, or a merge kept for its result all leave one
	 * behind, under a name that says nothing about what is in it. The folder
	 * cannot answer which those are - only the notes can, so they are read.
	 *
	 * Driven from the settings tab, next to the two folders that decide what it
	 * looks at and what it reads.
	 */
	async cleanUpUnusedRepertoires() {
		const storageFolder = this.dataAdapter.storagePath;
		const searchFolder = this.settings.notesFolder.trim();

		// Read lazily, and only up to the point where every repertoire has been
		// accounted for: a vault whose repertoires are all in use never gets past
		// the notes holding them.
		const notes = this.app.vault
			.getFiles()
			.filter(
				(file) =>
					isSearchableNote(file.extension) &&
					isInSearchFolder(file.path, searchFolder)
			)
			.map((file) => ({
				path: file.path,
				read: () => this.app.vault.cachedRead(file),
			}));

		// A folder with nothing in it to read would call every repertoire unused,
		// and the folder being wrong is a likelier explanation than the vault
		// having abandoned all of them. Only when one was named: a vault with no
		// notes at all really has nothing using its repertoires.
		if (searchFolder && !notes.length) {
			new Notice(
				`Chess Repertoire found no notes in "${searchFolder}", so nothing was checked. Change the notes folder in the settings, or leave it empty to search the whole vault.`,
				0
			);

			return;
		}

		let scan: UnusedScan;

		try {
			scan = await findUnusedRepertoires(
				this.app.vault.adapter,
				storageFolder,
				notes
			);
		} catch (e) {
			// A note that could not be read is a note that might have been the one
			// naming a repertoire, so the whole run is abandoned rather than acted
			// on: the answer this gives is only as good as its reading of the notes.
			console.error(
				'chess-repertoire: could not read the notes while looking for unused repertoires',
				e
			);

			new Notice(
				'Chess Repertoire could not read every note it needed to, so nothing was deleted.',
				0
			);

			return;
		}

		const searched = searchFolder ? `"${searchFolder}"` : 'your vault';

		const left = scan.skipped
			? ` ${plural(scan.skipped, 'other file', 'other files')} in the folder ${
					scan.skipped === 1 ? 'is' : 'are'
			  } not something the plugin wrote, and will be left alone.`
			: '';

		if (!scan.unused.length) {
			new Notice(
				`Every repertoire in "${storageFolder}" is used by a note in ${searched}.${left}`,
				scan.skipped ? 0 : undefined
			);

			return;
		}

		const files = unusedFileCount(scan.unused);

		new ConfirmModal(this.app, {
			title: 'Delete unused repertoire files?',
			body: `You are about to delete ${plural(
				files,
				'unused file',
				'unused files'
			)} from "${storageFolder}". No note in ${searched} refers to ${
				scan.unused.length === 1 ? 'it' : 'them'
			}, and ${files === 1 ? 'it goes' : 'they go'} to the trash.${left}`,
			details: {
				summary: `Show the ${plural(files, 'file', 'files')}`,
				items: unusedFileLines(scan.unused),
			},
			confirmText: 'Move to trash',
			onConfirm: () => void this.trashUnusedRepertoires(scan.unused),
		}).open();
	}

	/** Trashes what the user has just agreed to, and reports what actually went. */
	private async trashUnusedRepertoires(unused: UnusedRepertoire[]) {
		let trashed = 0;
		let failed = 0;

		for (const { paths } of unused)
			for (const path of paths) {
				try {
					await this.dataAdapter.trashFile(path);

					trashed += 1;
				} catch (e) {
					console.error(`chess-repertoire: could not delete ${path}`, e);

					failed += 1;
				}
			}

		new Notice(
			[
				`Chess Repertoire moved ${plural(trashed, 'file', 'files')} to the trash.`,
				failed &&
					`${plural(failed, 'file', 'files')} could not be deleted and ${
						failed === 1 ? 'is' : 'are'
					} still in the folder.`,
			]
				.filter(Boolean)
				.join(' '),
			failed ? 0 : undefined
		);
	}

	/**
	 * Routes the widget's shortcuts around CodeMirror.
	 *
	 * Two ways in, because neither covers everything on its own. The editor
	 * extension is the one that matters in Live Preview, where it runs ahead of
	 * the Vim keymap; the window listener catches Reading view and anywhere the
	 * extension does not reach. Whichever arrives first stops the other, so a
	 * key is never acted on twice.
	 */
	private registerRepertoireKeyboard() {
		this.registerEditorExtension(chessRepertoireKeymap());

		this.registerDomEvent(
			window,
			'keydown',
			(event) => handleRepertoireKey(event),
			{ capture: true }
		);

		this.registerDomEvent(document, 'pointerdown', releaseOnOutsideClick, {
			capture: true,
		});
	}

	/**
	 * A bare position, for anywhere a board is wanted without a repertoire behind it
	 * - the cards of an exported map, most of all, which would otherwise be
	 * lines of notation with nothing to look at.
	 */
	private registerPositionBlock() {
		this.registerMarkdownCodeBlockProcessor(
			'chessPosition',
			(source, el, ctx) => {
				const config = parsePositionConfig(this.settings, source);

				if (!config) {
					el.createEl('p', {
						text: 'This chessPosition block has no readable FEN.',
						cls: 'cs-empty-state',
					});

					return;
				}

				ctx.addChild(new PositionView(el, this.app, this.settings, config));
			}
		);
	}

	/**
	 * The repertoire ids of every chessRepertoire block in a note, in the order they
	 * appear. A block whose settings will not parse is left out rather than
	 * taken as an error: it would not render either.
	 */
	private repertoireIdsIn(content: string): string[] {
		return findCodeBlocks(content, 'chessRepertoire')
			.map((body) => {
				try {
					return (
						parseUserConfig(this.settings, body).chessRepertoireId?.trim() ?? ''
					);
				} catch {
					return '';
				}
			})
			.filter(Boolean);
	}

	/**
	 * Points the adapter at the configured folder, makes sure it is there, and
	 * brings the repertoires along from wherever they currently are.
	 *
	 * Called whenever the setting settles on a new value. Does nothing when the
	 * folder has not actually moved, so calling it twice is free.
	 */
	async applyStorageFolder() {
		const previous = this.settledStoragePath;

		this.dataAdapter.setStoragePath(this.storagePath);

		await this.dataAdapter.createStorageFolderIfNotExists();

		if (previous === this.storagePath) return;

		// Recorded before the move rather than after: a move that throws half way
		// has already left files in the new folder, and the next change should
		// start from there rather than trying the old folder again.
		this.settledStoragePath = this.storagePath;

		try {
			const { transferred, skipped, failed } = await moveStorageFiles(
				this.app.vault.adapter,
				previous,
				this.storagePath
			);

			if (transferred)
				new Notice(
					`Chess Repertoire moved ${transferred} ${
						transferred === 1 ? 'file' : 'files'
					} into "${this.storagePath}".`
				);

			if (skipped)
				new Notice(
					`Chess Repertoire left ${skipped} ${
						skipped === 1 ? 'file' : 'files'
					} in "${previous}": something of the same name was already in "${
						this.storagePath
					}".`,
					0
				);

			if (failed)
				new Notice(
					`Chess Repertoire could not move ${failed} ${
						failed === 1 ? 'file' : 'files'
					} out of "${previous}". ${
						failed === 1 ? 'It is' : 'They are'
					} still there and can be moved by hand.`,
					0
				);
		} catch (e) {
			// The new folder is already in effect, so the worst case is repertoires
			// left in the old one - recoverable by hand, and not worth failing the
			// setting change over.
			console.error(
				'chess-repertoire: could not move the repertoires to the new folder',
				e
			);

			new Notice(
				`Chess Repertoire could not move your repertoires out of "${previous}". They are still there.`,
				0
			);
		}
	}

	/**
	 * Walks the vault through whatever migrations it has not been through, and
	 * records how far it got.
	 *
	 * Never fatal: a migration that throws must not stop the plugin loading, or a
	 * vault it cannot migrate becomes a vault it cannot open either.
	 */
	private async runMigrations() {
		if (this.settings.dataVersion >= CURRENT_DATA_VERSION) return;

		try {
			const { version, notices } = await runMigrations(this.settings.dataVersion, {
				adapter: this.app.vault.adapter,
				configDir: this.app.vault.configDir,
				pluginId: this.manifest.id,
				storagePath: this.storagePath,
			});

			if (version !== this.settings.dataVersion) {
				this.settings.dataVersion = version;

				await this.saveSettings();
			}

			// Persistent: these say where a user's repertoires went, which is not
			// something to catch out of the corner of an eye.
			for (const notice of notices) new Notice(notice, 0);
		} catch (e) {
			console.error('chess-repertoire: could not migrate the vault', e);
		}
	}

	async loadSettings() {
		const saved = (await this.loadData()) as
			| Partial<ChessRepertoirePluginSettings>
			| null
			| undefined;

		this.settings = { ...DEFAULT_SETTINGS, ...saved };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
