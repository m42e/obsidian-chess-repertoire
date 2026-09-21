import { MoveClassification } from 'src/lib/classification';
import { uciLineToSan } from 'src/lib/pgn';
import {
	StockfishMoveEvaluation,
	StockfishPositionEvaluation,
	StockfishReport,
} from './types';

// Stockfish.js is a browser-compatible UCI module. The JS asset is bundled by
// esbuild; its WASM binary is loaded from the plugin folder at runtime.
import * as STOCKFISH_MODULE from './vendor/stockfish-19-lite-single.js';

const STOCKFISH_FACTORY = (() => {
	const moduleValue = STOCKFISH_MODULE as unknown as {
		default?: unknown;
	};
	return (moduleValue.default || moduleValue) as () => (
		config: Record<string, unknown>
	) => Promise<StockfishEngine>;
})();

interface StockfishEngine {
	ready: Promise<unknown>;
	ccall(
		name: string,
		returnType: null,
		argumentTypes: string[],
		argumentsList: string[],
		options?: { async?: boolean }
	): void;
	terminate?: () => void;
}

export class StockfishAnalysisCancelled extends Error {
	constructor() {
		super('Stockfish analysis cancelled');
		this.name = 'StockfishAnalysisCancelled';
	}
}

interface ParsedInfo {
	depth: number;
	scoreType: 'cp' | 'mate';
	score: number;
	pv: string;
}

const parseInfoLine = (line: string): ParsedInfo | null => {
	const match = line.match(
		/\bdepth (\d+).*?\bscore (cp (-?\d+)|mate (-?\d+)).*?\bpv (.+)$/
	);
	if (!match) return null;

	return {
		depth: Number(match[1]),
		scoreType: match[3] ? 'cp' : 'mate',
		score: Number(match[3] || match[4]),
		pv: match[5].trim(),
	};
};

const parseBestMoveLine = (
	line: string
): { bestMove: string; ponder: string | null } | null => {
	const match = line.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
	return match ? { bestMove: match[1], ponder: match[2] || null } : null;
};

const scoreForWhite = (
	info: ParsedInfo | null,
	turn: 'w' | 'b'
): StockfishPositionEvaluation['score'] => {
	if (!info) return null;
	const sign = turn === 'w' ? 1 : -1;
	return {
		type: info.scoreType,
		value: info.score * sign,
	};
};

const scoreText = (score: StockfishPositionEvaluation['score']): string => {
	if (!score) return '?';
	if (score.type === 'mate') return `#${score.value}`;
	return (score.value / 100).toFixed(2);
};

const scoreForSwing = (
	score: StockfishPositionEvaluation['score']
): number | null => {
	if (!score) return null;
	return score.type === 'mate' ? score.value * 100000 : score.value;
};

const moveSwing = (
	before: StockfishPositionEvaluation,
	after: StockfishPositionEvaluation,
	color: 'w' | 'b'
): number | null => {
	const beforeValue = scoreForSwing(before.score);
	const afterValue = scoreForSwing(after.score);
	if (beforeValue === null || afterValue === null) return null;
	return color === 'w' ? afterValue - beforeValue : beforeValue - afterValue;
};

export const classificationForLoss = (
	lossCp: number | null
): MoveClassification | null => {
	if (lossCp === null) return null;
	if (lossCp <= 20) return 'excellent';
	if (lossCp <= 50) return 'good';
	if (lossCp <= 100) return 'inaccuracy';
	if (lossCp <= 200) return 'mistake';
	return 'blunder';
};

const accuracyForLoss = (lossCp: number | null): number | null => {
	if (lossCp === null) return null;
	return Math.max(0, Math.min(100, 100 * Math.exp(-lossCp / 300)));
};

const performanceRating = (
	accuracy: number | undefined,
	rating: number | undefined
): number | undefined => {
	if (!Number.isFinite(accuracy)) return undefined;
	if (!Number.isFinite(rating)) return undefined;
	return Math.round(rating! + (accuracy! - 50) * 10);
};

type StockfishReportCallback = (
	report: StockfishReport
) => void | Promise<void>;

const evaluationForMove = (
	move: {
		color: 'w' | 'b';
		san: string;
	},
	index: number,
	evaluated: StockfishPositionEvaluation[]
): StockfishMoveEvaluation => {
	const before = evaluated[index * 2];
	const after = evaluated[index * 2 + 1];
	const swingCp = moveSwing(before, after, move.color);

	return {
		index,
		color: move.color,
		san: move.san,
		before,
		after,
		swingCp,
		classification: classificationForLoss(Math.max(0, -(swingCp || 0))),
	};
};

const reportForEvaluations = (
	evaluations: StockfishMoveEvaluation[],
	depth: number,
	totalPlies: number,
	ratings: { white?: number; black?: number }
): StockfishReport => {
	const whiteLosses = evaluations
		.filter((evaluation) => evaluation.color === 'w')
		.map((evaluation) => Math.max(0, -(evaluation.swingCp || 0)));
	const blackLosses = evaluations
		.filter((evaluation) => evaluation.color === 'b')
		.map((evaluation) => Math.max(0, -(evaluation.swingCp || 0)));
	const average = (values: number[]) =>
		values.length
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: null;
	const whiteAccuracy = accuracyForLoss(average(whiteLosses));
	const blackAccuracy = accuracyForLoss(average(blackLosses));

	return {
		engine: 'Stockfish 19 Lite WASM',
		depth,
		analyzedPlies: evaluations.length,
		totalPlies,
		evaluations: [...evaluations],
		whiteAccuracy: whiteAccuracy ?? undefined,
		blackAccuracy: blackAccuracy ?? undefined,
		whitePerformanceRating: performanceRating(
			whiteAccuracy ?? undefined,
			ratings.white
		),
		blackPerformanceRating: performanceRating(
			blackAccuracy ?? undefined,
			ratings.black
		),
	};
};

export const hasCompleteAccuracy = (report: StockfishReport): boolean => {
	const hasWhiteMoves = report.evaluations.some(
		(evaluation) => evaluation.color === 'w'
	);
	const hasBlackMoves = report.evaluations.some(
		(evaluation) => evaluation.color === 'b'
	);

	return (
		(hasWhiteMoves || hasBlackMoves) &&
		(!hasWhiteMoves || Number.isFinite(report.whiteAccuracy)) &&
		(!hasBlackMoves || Number.isFinite(report.blackAccuracy))
	);
};

export const canUseStockfishCache = (
	report: StockfishReport,
	totalPlies: number
): boolean => {
	return (
		report.totalPlies === totalPlies &&
		report.analyzedPlies >= 0 &&
		report.analyzedPlies <= totalPlies &&
		report.evaluations.length === report.analyzedPlies &&
		report.evaluations.every((evaluation, index) => evaluation.index === index) &&
		hasCompleteAccuracy(report)
	);
};

export const combineStockfishReports = (
	previous: StockfishReport | null,
	next: StockfishReport,
	totalPlies: number,
	ratings: { white?: number; black?: number }
): StockfishReport => {
	const existing = previous?.evaluations ?? [];
	const evaluations = [
		...existing,
		...next.evaluations.map((evaluation) => ({
			...evaluation,
			index: evaluation.index + existing.length,
		})),
	];

	return reportForEvaluations(evaluations, next.depth, totalPlies, ratings);
};

export class StockfishAnalyzer {
	private engine: StockfishEngine | null = null;
	private ready: Promise<StockfishEngine> | null = null;
	private lines: string[] = [];
	private commandQueue: Promise<unknown> = Promise.resolve();
	private cancelWait: (() => void) | null = null;
	private cancelled = false;

	constructor(
		private readonly wasmBinary: ArrayBuffer,
		private readonly depth: number,
		private readonly onProgress: (
			completed: number,
			total: number
		) => void = () => undefined
	) {}

	private async initialize(): Promise<StockfishEngine> {
		if (this.cancelled) throw new StockfishAnalysisCancelled();
		if (this.ready) return this.ready;

		this.ready = Promise.resolve(
			STOCKFISH_FACTORY()({
				wasmBinary: this.wasmBinary,
				listener: (line: unknown) => this.lines.push(String(line)),
			})
		).then(async (engine) => {
			this.engine = engine;
			if (this.cancelled) {
				engine.terminate?.();
				throw new StockfishAnalysisCancelled();
			}
			await engine.ready;
			if (this.cancelled) {
				engine.terminate?.();
				throw new StockfishAnalysisCancelled();
			}
			this.send('uci');
			this.send('setoption name Threads value 1');
			this.send('setoption name Hash value 16');
			this.send('isready');
			return engine;
		});

		return this.ready;
	}

	private send(command: string): void {
		if (!this.engine) throw new Error('Stockfish is not initialized');
		this.engine.ccall('command', null, ['string'], [command], {
			async: /^go\b/.test(command),
		});
	}

	private waitForBestMove(): Promise<string[]> {
		const started = Date.now();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (this.cancelWait === cancel) this.cancelWait = null;
				callback();
			};
			const cancel = () => finish(() => reject(new StockfishAnalysisCancelled()));
			this.cancelWait = cancel;
			const check = () => {
				if (this.cancelled) {
					cancel();
					return;
				}
				const index = this.lines.findIndex((line) => line.startsWith('bestmove '));
				if (index >= 0) {
					finish(() => resolve(this.lines.splice(0, index + 1)));
					return;
				}
				if (Date.now() - started > 120000) {
					finish(() => reject(new Error('Stockfish analysis timed out')));
					return;
				}
				setTimeout(check, 20);
			};
			check();
		});
	}

	private analyzePosition(
		fen: string,
		turn: 'w' | 'b',
		index: number,
		total: number
	): Promise<StockfishPositionEvaluation> {
		this.commandQueue = this.commandQueue.then(async () => {
			if (this.cancelled) throw new StockfishAnalysisCancelled();
			await this.initialize();
			this.lines.length = 0;
			this.send(`position fen ${fen}`);
			this.send(`go depth ${this.depth}`);
			const output = await this.waitForBestMove();
			const info = output.map(parseInfoLine).filter(Boolean).at(-1) || null;
			const bestMove = output.map(parseBestMoveLine).find(Boolean) || null;
			const score = scoreForWhite(info, turn);
			const result: StockfishPositionEvaluation = {
				fen,
				turn,
				depth: info?.depth || this.depth,
				score,
				scoreText: scoreText(score),
				pv: info?.pv || '',
				pvSan: info ? uciLineToSan(fen, info.pv) : '',
				bestMove: bestMove?.bestMove || null,
				bestMoveSan: bestMove ? uciLineToSan(fen, bestMove.bestMove) : null,
				ponder: bestMove?.ponder || null,
			};
			this.onProgress(index + 1, total);
			return result;
		});

		return this.commandQueue as Promise<StockfishPositionEvaluation>;
	}

	async analyze(
		moves: Array<{
			before: string;
			after: string;
			color: 'w' | 'b';
			san: string;
		}>,
		maxPlies: number,
		ratings: { white?: number; black?: number } = {},
		onReport?: StockfishReportCallback
	): Promise<StockfishReport> {
		const selected = moves.slice(0, maxPlies > 0 ? maxPlies : moves.length);
		const positions: Array<{ fen: string; turn: 'w' | 'b' }> = [];
		for (const move of selected) {
			positions.push({ fen: move.before, turn: move.color });
			positions.push({ fen: move.after, turn: move.color === 'w' ? 'b' : 'w' });
		}

		const evaluated: StockfishPositionEvaluation[] = [];
		const evaluations: StockfishMoveEvaluation[] = [];
		for (let index = 0; index < selected.length; index++) {
			evaluated.push(
				await this.analyzePosition(
					positions[index * 2].fen,
					positions[index * 2].turn,
					index * 2,
					positions.length
				)
			);
			evaluated.push(
				await this.analyzePosition(
					positions[index * 2 + 1].fen,
					positions[index * 2 + 1].turn,
					index * 2 + 1,
					positions.length
				)
			);

			evaluations.push(evaluationForMove(selected[index], index, evaluated));
			if (onReport)
				await onReport(
					reportForEvaluations(evaluations, this.depth, moves.length, ratings)
				);
		}

		return reportForEvaluations(evaluations, this.depth, moves.length, ratings);
	}

	async bestMove(fen: string): Promise<string | null> {
		this.commandQueue = this.commandQueue.then(async () => {
			if (this.cancelled) throw new StockfishAnalysisCancelled();
			await this.initialize();
			this.lines.length = 0;
			this.send(`position fen ${fen}`);
			this.send(`go depth ${this.depth}`);
			const output = await this.waitForBestMove();
			return output.map(parseBestMoveLine).find(Boolean)?.bestMove ?? null;
		});

		return this.commandQueue as Promise<string | null>;
	}

	cancel(): void {
		this.cancelled = true;
		this.cancelWait?.();
		this.shutdown();
	}

	shutdown(): void {
		this.cancelled = true;
		this.cancelWait?.();
		try {
			if (this.engine) this.send('quit');
		} finally {
			this.engine?.terminate?.();
			this.engine = null;
			this.ready = null;
		}
	}
}
