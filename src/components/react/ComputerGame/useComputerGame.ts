import { Move, PieceSymbol } from 'chess.js';
import { App, Notice } from 'obsidian';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ColorChoiceModal } from 'src/components/obsidian/ColorChoiceModal';
import type { GameActions } from 'src/components/react/ChessRepertoire';
import { toColor } from 'src/lib/chess-logic';
import type { TrainerColor } from 'src/lib/trainer';

export type ComputerGameStatus =
	| 'idle'
	| 'your-turn'
	| 'thinking'
	| 'complete'
	| 'error';

export interface ComputerGame {
	isActive: boolean;
	playerColor: TrainerColor;
	status: ComputerGameStatus;
	isBoardLocked: boolean;
	start: () => void;
	stop: () => void;
	submitMove: (move: Move) => void;
}

interface UseComputerGameOptions {
	app: App;
	currentMoveId: string | null;
	chess: import('chess.js').Chess;
	dispatch: React.Dispatch<GameActions>;
	repertoireColor: 'w' | 'b' | undefined;
	onBestMove?: (fen: string) => Promise<string | null>;
	playMove: (from: string, to: string, promotion?: PieceSymbol) => Move | null;
}

const parseUciMove = (
	uci: string
): {
	from: string;
	to: string;
	promotion?: PieceSymbol;
} | null => {
	const match = uci.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);

	if (!match) return null;

	return {
		from: match[1],
		to: match[2],
		promotion: match[3] as PieceSymbol | undefined,
	};
};

export const useComputerGame = ({
	app,
	currentMoveId,
	chess,
	dispatch,
	repertoireColor,
	onBestMove,
	playMove,
}: UseComputerGameOptions): ComputerGame => {
	const [isActive, setIsActive] = useState(false);
	const [playerColor, setPlayerColor] = useState<TrainerColor>(
		repertoireColor === 'b' ? 'black' : 'white'
	);
	const [hasError, setHasError] = useState(false);
	const sessionRef = useRef(0);
	const isPlayerTurn = toColor(chess) === playerColor;
	const status: ComputerGameStatus = !isActive
		? 'idle'
		: hasError
		? 'error'
		: chess.isGameOver()
		? 'complete'
		: isPlayerTurn
		? 'your-turn'
		: 'thinking';

	const start = useCallback(() => {
		if (!onBestMove) {
			new Notice('Stockfish is not available in this plugin build.');
			return;
		}

		if (chess.isGameOver()) {
			new Notice('The current position is already over.');
			return;
		}

		new ColorChoiceModal(app, {
			body:
				'Stockfish will play the other side from the position currently on the board. Moves are added to the current branch.',
			current:
				repertoireColor === 'b'
					? 'black'
					: repertoireColor === 'w'
					? 'white'
					: undefined,
			onChoose: (color) => {
				sessionRef.current++;
				setPlayerColor(color);
				setHasError(false);
				setIsActive(true);
			},
		}).open();
	}, [app, chess, onBestMove, repertoireColor]);

	const stop = useCallback(() => {
		sessionRef.current++;
		setIsActive(false);
		setHasError(false);
	}, []);

	useEffect(() => {
		if (!isActive) return;

		if (hasError || chess.isGameOver() || isPlayerTurn) return;

		const session = sessionRef.current;
		const fen = chess.fen();
		let cancelled = false;

		void onBestMove!(fen)
			.then((uci) => {
				if (
					cancelled ||
					!isActive ||
					sessionRef.current !== session ||
					chess.fen() !== fen
				)
					return;

				const parsed = uci ? parseUciMove(uci) : null;
				if (!parsed) {
					setHasError(true);
					return;
				}

				const move = playMove(parsed.from, parsed.to, parsed.promotion);
				if (!move) {
					setHasError(true);
					return;
				}

				dispatch({ type: 'ADD_MOVE_TO_HISTORY', move });
			})
			.catch(() => {
				if (!cancelled && isActive && sessionRef.current === session)
					setHasError(true);
			});

		return () => {
			cancelled = true;
		};
	}, [
		chess,
		currentMoveId,
		dispatch,
		hasError,
		isActive,
		isPlayerTurn,
		onBestMove,
		playMove,
	]);

	const submitMove = useCallback(
		(move: Move) => {
			if (!isActive || !isPlayerTurn) return;

			dispatch({ type: 'ADD_MOVE_TO_HISTORY', move });
		},
		[dispatch, isActive, isPlayerTurn]
	);

	return {
		isActive,
		playerColor,
		status,
		isBoardLocked:
			isActive && (!isPlayerTurn || status === 'complete' || status === 'error'),
		start,
		stop,
		submitMove,
	};
};
