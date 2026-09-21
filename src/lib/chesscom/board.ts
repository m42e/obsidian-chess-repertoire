import { mergeRepertoires } from 'src/lib/merge';
import { ChessRepertoireFileData } from 'src/lib/storage';
import { annotateRepertoire } from './notes';
import { repertoireFromGame } from './pgn';
import { ChessComGameRecord } from './types';

export const repertoireForChessComBoard = (
	existing: ChessRepertoireFileData | null,
	game: ChessComGameRecord,
	id: string,
	version: string
): ChessRepertoireFileData => {
	let imported = repertoireFromGame(game, id);
	if (game.stockfish) imported = annotateRepertoire(imported, game.stockfish);

	if (!existing) return imported;

	const merged = mergeRepertoires([existing, imported], version).repertoire;
	return {
		...merged,
		header: existing.header,
		rootFEN: existing.rootFEN,
		playerColor: existing.playerColor ?? imported.playerColor,
	};
};
