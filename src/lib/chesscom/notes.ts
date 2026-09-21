import { CLASSIFICATIONS } from 'src/lib/classification';
import { commentToPlainText } from 'src/lib/comments';
import { classificationForLoss } from 'src/lib/engine';
import { StockfishReport } from 'src/lib/engine/types';
import { ChessRepertoireFileData } from 'src/lib/storage';
import { hashString } from './pgn';
import { ChessComGameRecord } from './types';

export const START_MARKER = '<!-- chess-com-daily:start -->';
export const END_MARKER = '<!-- chess-com-daily:end -->';

const escapeHeading = (value: string): string =>
	value.replace(/[\r\n#]/g, ' ').trim();

const accuracy = (value: unknown): string | null => {
	const number = Number(value);
	return Number.isFinite(number) ? `${number.toFixed(1)}%` : null;
};

const swing = (value: number | null): string =>
	Number.isFinite(value)
		? `${value! >= 0 ? '+' : ''}${(value! / 100).toFixed(2)}`
		: 'n/a';

const cell = (value: unknown): string => {
	const text =
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
			? `${value}`
			: '';
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};

const moveLabel = (index: number, color: 'w' | 'b'): string =>
	`${Math.floor(index / 2) + 1}${color === 'b' ? '...' : '.'}`;

export const analysisMarkdown = (game: ChessComGameRecord): string => {
	const parts: string[] = [];
	const whiteAccuracy = accuracy(game.accuracies.white);
	const blackAccuracy = accuracy(game.accuracies.black);
	if (whiteAccuracy) parts.push(`White accuracy ${whiteAccuracy}`);
	if (blackAccuracy) parts.push(`Black accuracy ${blackAccuracy}`);
	if (Number.isFinite(game.ratings.white) || Number.isFinite(game.ratings.black))
		parts.push(
			`Chess.com rating: White ${game.ratings.white ?? 'n/a'}, Black ${
				game.ratings.black ?? 'n/a'
			}`
		);
	if (game.analysisUrl)
		parts.push(`[Open Chess.com analysis](${game.analysisUrl})`);

	const report = game.stockfish;
	if (report) {
		const swings = report.evaluations
			.map((evaluation) => evaluation.swingCp)
			.filter((value): value is number => Number.isFinite(value));
		const largest = swings.length ? Math.min(...swings) : null;
		parts.push(
			`Stockfish depth ${report.depth} (${report.analyzedPlies}/${
				report.totalPlies
			} plies)${largest === null ? '' : `; largest swing ${swing(largest)}`}`
		);
	}
	if (report && (report.whitePerformanceRating || report.blackPerformanceRating))
		parts.push(
			`Estimated performance rating: White ${
				report.whitePerformanceRating ?? 'n/a'
			}, Black ${report.blackPerformanceRating ?? 'n/a'}`
		);
	if (game.stockfishError)
		parts.push(`Stockfish unavailable: ${cell(game.stockfishError)}`);
	if (!parts.length) parts.push('No analysis data available');

	const lines = [`- **Analysis:** ${parts.join('; ')}`];
	if (report?.evaluations.length) {
		lines.push(
			'',
			'<details>',
			'<summary>Stockfish move review</summary>',
			'',
			'| Move | Played | Quality | Before | After | Swing | Engine best | Principal variation |',
			'| --- | --- | --- | ---: | ---: | ---: | --- | --- |',
			...report.evaluations.map((evaluation) =>
				[
					moveLabel(evaluation.index, evaluation.color),
					cell(evaluation.san),
					cell(
						evaluation.classification
							? CLASSIFICATIONS[evaluation.classification].label
							: ''
					),
					cell(evaluation.before.scoreText),
					cell(evaluation.after.scoreText),
					swing(evaluation.swingCp),
					cell(evaluation.before.bestMoveSan),
					cell(evaluation.before.pvSan),
				].join(' | ')
			),
			'',
			'</details>'
		);
	}
	return lines.join('\n');
};

export const gameMarkdown = (
	game: ChessComGameRecord,
	settings: {
		includePgn: boolean;
		includeAnalysis: boolean;
		includeBoards: boolean;
	}
): string => {
	const lines = [
		`### ${escapeHeading(game.white)} vs ${escapeHeading(game.black)} - ${
			game.result
		}`,
		`<!-- chess-com-game:${encodeURIComponent(game.key)} -->`,
		`- **Your color:** ${
			game.playerColor === 'w'
				? 'White'
				: game.playerColor === 'b'
				? 'Black'
				: 'Could not match username'
		}`,
		`- **Result:** ${game.result}${
			game.playerResult ? ` (${game.playerResult})` : ''
		}`,
	];
	if (game.timeClass || game.timeControl)
		lines.push(
			`- **Time:** ${[game.timeClass, game.timeControl]
				.filter(Boolean)
				.join(' / ')}`
		);
	if (game.eco) lines.push(`- **Opening:** \`${cell(game.eco)}\``);
	if (game.url) lines.push(`- **Game:** [View on Chess.com](${game.url})`);
	if (game.repertoireMatch)
		lines.push(
			`- **Repertoire:** [[${game.repertoireMatch.id}|${cell(
				game.repertoireMatch.title
			)}]] (${game.repertoireMatch.length} moves matched: ${cell(
				game.repertoireMatch.line.join(' ')
			)})`
		);
	if (settings.includeAnalysis)
		lines.push(
			`- **Analysis:** ${analysisMarkdown(game).replace(
				/^- \*\*Analysis:\*\* /,
				''
			)}`
		);
	if (settings.includePgn)
		lines.push(
			'',
			'<details>',
			'<summary>PGN</summary>',
			'',
			'````pgn',
			game.pgn,
			'````',
			'',
			'</details>'
		);
	if (settings.includeBoards && game.boardId)
		lines.push(
			'',
			'```chessRepertoire',
			`chessRepertoireId: ${game.boardId}`,
			'```'
		);
	return lines.join('\n');
};

export const managedSection = (
	games: ChessComGameRecord[],
	settings: {
		includePgn: boolean;
		includeAnalysis: boolean;
		includeBoards: boolean;
	}
): string =>
	[
		START_MARKER,
		'## Chess.com games',
		'',
		...games
			.sort((first, second) => first.key.localeCompare(second.key))
			.flatMap((game) => [gameMarkdown(game, settings), '']),
		END_MARKER,
	]
		.join('\n')
		.replace(/\n{3,}/g, '\n\n');

export const gameBlockAtCursor = (
	content: string,
	cursorLine: number
): { startLine: number; endLine: number; text: string } | null => {
	const lines = content.split('\n');
	const start = lines.lastIndexOf(START_MARKER, cursorLine);
	const end = lines.indexOf(END_MARKER, cursorLine);
	if (
		start < 0 ||
		end < 0 ||
		start >= end ||
		cursorLine <= start ||
		cursorLine >= end
	)
		return null;

	let blockStart = cursorLine;
	while (blockStart > start && !/^###\s+/.test(lines[blockStart])) blockStart--;
	if (!/^###\s+/.test(lines[blockStart])) return null;

	let blockEnd = blockStart + 1;
	while (blockEnd < end && !/^###\s+/.test(lines[blockEnd])) blockEnd++;
	return {
		startLine: blockStart,
		endLine: blockEnd,
		text: lines.slice(blockStart, blockEnd).join('\n'),
	};
};

export const pgnFromBlock = (block: string): string | null =>
	block.match(/`{4}pgn\r?\n([\s\S]*?)\r?\n`{4}/)?.[1].trim() ?? null;

const gameKeyFromBlock = (block: string): string | null => {
	const marker = block.match(/<!-- chess-com-game:([^>]+) -->/)?.[1];
	if (marker !== undefined) {
		try {
			return decodeURIComponent(marker);
		} catch {
			return null;
		}
	}

	const url = block.match(/^- \*\*Game:\*\* \[[^\]]*\]\(([^)]+)\)/m)?.[1];
	if (url) return url;

	const pgn = pgnFromBlock(block);
	return pgn ? `pgn-${hashString(pgn)}` : null;
};

const gameBlocksInSection = (section: string): string[] => {
	const end = section.indexOf(END_MARKER);
	const lines = section.slice(0, end < 0 ? section.length : end).split('\n');
	const starts = lines.reduce<number[]>(
		(indices, line, index) =>
			/^###\s+/.test(line) ? [...indices, index] : indices,
		[]
	);

	return starts.map((start, index) =>
		lines
			.slice(start, starts[index + 1] ?? lines.length)
			.join('\n')
			.trim()
	);
};

export const mergeManagedSection = (
	existingSection: string,
	games: ChessComGameRecord[],
	settings: {
		includePgn: boolean;
		includeAnalysis: boolean;
		includeBoards: boolean;
	}
): string => {
	const end = existingSection.indexOf(END_MARKER);
	if (end < 0) return managedSection(games, settings);

	const existingKeys = new Set(
		gameBlocksInSection(existingSection)
			.map(gameKeyFromBlock)
			.filter((key): key is string => key !== null)
	);
	const additions = games
		.filter((game) => !existingKeys.has(game.key))
		.sort((first, second) => first.key.localeCompare(second.key));

	if (!additions.length) return existingSection;

	return `${existingSection.slice(0, end).trimEnd()}\n\n${additions
		.map((game) => gameMarkdown(game, settings))
		.join('\n\n')}\n${existingSection.slice(end)}`;
};

export const replaceAnalysis = (block: string, analysis: string): string => {
	const start = block.indexOf('- **Analysis:**');
	const boundaries = [
		block.search(/\n\n<details>\r?\n<summary>PGN<\/summary>/),
		block.indexOf('\n\n```chessRepertoire'),
	].filter((index) => index >= 0);
	const insertion = boundaries.length ? Math.min(...boundaries) : block.length;
	const before = (
		start >= 0 ? block.slice(0, start) : block.slice(0, insertion)
	).trimEnd();
	const after = block.slice(insertion).replace(/^\n+/, '\n\n');
	return `${before}\n${analysis}${after}`;
};

export const annotateRepertoire = (
	data: ChessRepertoireFileData,
	report: StockfishReport
): ChessRepertoireFileData => ({
	...data,
	moves: data.moves.map((move, index) => {
		const evaluation = report.evaluations.find((item) => item.index === index);
		if (!evaluation) return move;
		const text = `Stockfish: ${evaluation.before.scoreText} -> ${
			evaluation.after.scoreText
		}; best ${evaluation.before.bestMoveSan || '?'}; swing ${swing(
			evaluation.swingCp
		)}.`;
		return {
			...move,
			classification:
				move.classification ??
				evaluation.classification ??
				classificationForLoss(Math.max(0, -(evaluation.swingCp ?? 0))),
			comment: {
				type: 'doc',
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'text', text: existingComment(move.comment, text) }],
					},
				],
			},
		};
	}),
});

const existingComment = (
	comment: ChessRepertoireFileData['moves'][number]['comment'],
	text: string
): string => {
	const existing = commentToPlainText(comment, Infinity);
	if (existing.startsWith('Stockfish:')) return existing;
	return existing ? `${existing} ${text}` : text;
};
