export const isImportedGameBoardId = (id: string): boolean =>
	/^(?:chesscom|lichess)-/.test(id);
