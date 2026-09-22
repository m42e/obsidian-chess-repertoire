import { isImportedGameBoardId } from 'src/lib/imports';
import { looksLikeFen, parsePgn, titleFromHeaders } from 'src/lib/pgn';
import { ChessRepertoireFileData, ChessRepertoireMove } from 'src/lib/storage';
import { LichessGameRecord } from './types';

const parseDate = (value: string | undefined): Date | null => {
	const match = value?.match(/^(\d{4})[./-](\d{2})[./-](\d{2})/);
	if (!match) return null;

	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3])
	);
	return Number.isNaN(date.getTime()) ? null : date;
};

const timestampDate = (value: unknown): Date | null => {
	const timestamp = Number(value);
	if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? null : date;
};

const stringValue = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;

const recordValue = (value: unknown, key: string): unknown =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;

const playerName = (value: unknown, fallback: string): string => {
	if (typeof value === 'string' && value.trim()) return value.trim();

	const user = recordValue(value, 'user');
	const userName = stringValue(recordValue(user, 'name'));
	if (userName) return userName;

	const name = stringValue(recordValue(value, 'name'));
	if (name) return name;

	const id = stringValue(recordValue(user, 'id'));
	return id || fallback;
};

const playerColor = (
	white: string,
	black: string,
	username: string
): 'w' | 'b' | null => {
	const normalize = (value: string): string =>
		value.trim().replace(/^@/, '').toLowerCase();
	const target = normalize(username);
	if (!target) return null;
	if (normalize(white) === target) return 'w';
	if (normalize(black) === target) return 'b';
	return null;
};

const playerResult = (
	result: string,
	color: 'w' | 'b' | null
): 'win' | 'loss' | 'draw' | null => {
	if (!color || result === '*') return null;
	if (result === '1/2-1/2') return 'draw';

	const whiteWon = result === '1-0';
	return (color === 'w') === whiteWon ? 'win' : 'loss';
};

const participant = (
	rawGame: Record<string, unknown>,
	color: 'white' | 'black'
): Record<string, unknown> => {
	const players = recordValue(rawGame.players, color);
	return players && typeof players === 'object' && !Array.isArray(players)
		? (players as Record<string, unknown>)
		: {};
};

const participantNumber = (
	participantData: Record<string, unknown>,
	key: string
): number | undefined => {
	const value = Number(participantData[key]);
	return Number.isFinite(value) ? value : undefined;
};

const gameResult = (
	rawGame: Record<string, unknown>,
	headers: Record<string, string>
): string => {
	if (headers.Result) return headers.Result;

	const winner = stringValue(rawGame.winner).toLowerCase();
	if (winner === 'white') return '1-0';
	if (winner === 'black') return '0-1';

	const status = stringValue(rawGame.status).toLowerCase();
	return status && status !== 'started' && status !== 'created'
		? '1/2-1/2'
		: '*';
};

export const gameDate = (
	rawGame: Record<string, unknown>,
	headers: Record<string, string>
): Date =>
	timestampDate(rawGame.lastMoveAt) ||
	parseDate(headers.EndDate) ||
	parseDate(headers.UTCDate) ||
	parseDate(headers.Date) ||
	timestampDate(rawGame.createdAt) ||
	new Date();

export const parseHeaders = (pgn: string): Record<string, string> => {
	const headers: Record<string, string> = {};
	const pattern = /^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"\]\s*$/gm;
	let match: RegExpExecArray | null;

	while (true) {
		match = pattern.exec(pgn);
		if (!match) break;
		headers[match[1]] = match[2].replace(/\\([\\"])/g, '$1');
	}

	return headers;
};

const openingValue = (
	rawGame: Record<string, unknown>,
	headers: Record<string, string>,
	key: string
): string =>
	stringValue(
		recordValue(rawGame.opening, key),
		headers[key === 'name' ? 'Opening' : 'ECO'] || ''
	);

const timeControl = (
	rawGame: Record<string, unknown>,
	headers: Record<string, string>
): string => {
	if (headers.TimeControl) return headers.TimeControl;

	const clock = rawGame.clock;
	const initial = Number(recordValue(clock, 'initial'));
	const increment = Number(recordValue(clock, 'increment'));
	if (Number.isFinite(initial) && Number.isFinite(increment))
		return `${initial}+${increment}`;

	return '';
};

const accuracy = (
	participantData: Record<string, unknown>,
	headerValue: string | undefined
): number | undefined => {
	const analysis = recordValue(participantData, 'analysis');
	const value = Number(recordValue(analysis, 'accuracy'));
	if (Number.isFinite(value)) return value;

	const headerNumber = Number(headerValue);
	return Number.isFinite(headerNumber) ? headerNumber : undefined;
};

const cleanGameUrl = (url: string): string => url.split(/[?#]/, 1)[0];

export const analysisUrl = (url: string): string | null => {
	const cleanUrl = cleanGameUrl(url);
	return cleanUrl.startsWith('https://lichess.org/')
		? `${cleanUrl}/analysis`
		: null;
};

export const parseGame = (
	rawGame: Record<string, unknown>,
	username: string
): LichessGameRecord | null => {
	const pgn = stringValue(rawGame.pgn).trim();
	if (!pgn) return null;

	const headers = parseHeaders(pgn);
	const white = playerName(
		participant(rawGame, 'white'),
		headers.White || 'White'
	);
	const black = playerName(
		participant(rawGame, 'black'),
		headers.Black || 'Black'
	);
	const result = gameResult(rawGame, headers);
	const id = stringValue(rawGame.id);
	const url = (
		headers.Site ||
		stringValue(rawGame.url) ||
		(id ? `https://lichess.org/${id}` : '')
	).trim();
	const key = url || id || `pgn-${hashString(pgn)}`;
	const rules = stringValue(
		rawGame.variant,
		headers.Variant || 'standard'
	).toLowerCase();
	const rootFen = looksLikeFen(stringValue(rawGame.initialFen))
		? stringValue(rawGame.initialFen)
		: headers.FEN || ROOT_FEN;
	const whiteParticipant = participant(rawGame, 'white');
	const blackParticipant = participant(rawGame, 'black');
	let moveIndex = 0;
	const parsed = parsePgn(
		pgn,
		rootFen,
		() => `${hashString(key)}-${String(moveIndex++).padStart(4, '0')}`
	);
	const color = playerColor(white, black, username);

	return {
		key,
		pgn,
		headers,
		white,
		black,
		result,
		url,
		analysisUrl: analysisUrl(url),
		rules,
		timeClass: stringValue(
			rawGame.speed,
			headers.TimeClass || headers.Speed || ''
		),
		timeControl: timeControl(rawGame, headers),
		eco: openingValue(rawGame, headers, 'eco'),
		accuracies: {
			white: accuracy(whiteParticipant, headers.WhiteAccuracy),
			black: accuracy(blackParticipant, headers.BlackAccuracy),
		},
		ratings: {
			white:
				participantNumber(whiteParticipant, 'rating') ??
				(Number.isFinite(Number(headers.WhiteElo))
					? Number(headers.WhiteElo)
					: undefined),
			black:
				participantNumber(blackParticipant, 'rating') ??
				(Number.isFinite(Number(headers.BlackElo))
					? Number(headers.BlackElo)
					: undefined),
		},
		date: gameDate(rawGame, headers),
		parsed,
		playerColor: color,
		playerResult: playerResult(result, color),
	};
};

export const repertoireFromGame = (
	game: LichessGameRecord,
	id: string
): ChessRepertoireFileData => ({
	version: '0.0.7',
	header: { title: titleFromHeaders(game.headers) },
	moves: game.parsed.moves.map((move, index) => ({
		...move,
		moveId: move.moveId || `${id}-${String(index + 1).padStart(4, '0')}`,
	})),
	rootVariants: game.parsed.rootVariants,
	rootFEN: game.parsed.rootFEN,
	playerColor: game.playerColor ?? undefined,
});

export interface RepertoireMatch {
	id: string;
	title: string;
	length: number;
	line: string[];
}

const sameMove = (
	first: ChessRepertoireMove | undefined,
	second: ChessRepertoireMove
): boolean =>
	Boolean(first) &&
	(first!.lan && second.lan
		? first!.lan === second.lan
		: first!.san === second.san);

export const findBestRepertoireMatch = (
	gameMoves: ChessRepertoireMove[],
	entries: Array<{ id: string; repertoire: ChessRepertoireFileData }>
): RepertoireMatch | null => {
	let best: RepertoireMatch | null = null;

	const consider = (
		entry: { id: string; repertoire: ChessRepertoireFileData },
		length: number,
		line: string[]
	) => {
		if (!best || length > best.length)
			best = {
				id: entry.id,
				title: entry.repertoire.header.title || entry.id,
				length,
				line,
			};
	};

	const walk = (
		entry: { id: string; repertoire: ChessRepertoireFileData },
		nodes: ChessRepertoireMove[],
		index: number,
		line: string[]
	) => {
		let currentIndex = index;
		let currentLine = line;
		for (const node of nodes) {
			if (!sameMove(gameMoves[currentIndex], node)) break;
			currentIndex++;
			currentLine = [...currentLine, node.san];
			consider(entry, currentIndex, currentLine);
			for (const variant of node.variants || [])
				walk(entry, variant.moves, currentIndex, currentLine);
		}
	};

	for (const entry of entries) {
		if (isImportedGameBoardId(entry.id)) continue;
		walk(entry, entry.repertoire.moves, 0, []);
		for (const variant of entry.repertoire.rootVariants || [])
			walk(entry, variant.moves, 0, []);
	}

	return best;
};

export const hashString = (value: string): string => {
	let hash = 2166136261;
	for (const character of value) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
};

export const ROOT_FEN =
	'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
