import { X } from 'lucide-react';
import * as React from 'react';
import { ComputerGame, ComputerGameStatus } from './useComputerGame';

const STATUS_TEXT: Record<ComputerGameStatus, string> = {
	idle: '',
	'your-turn': 'Your move.',
	thinking: 'Stockfish is thinking...',
	complete: 'Game over.',
	error: 'Stockfish could not choose a move.',
};

export { useComputerGame } from './useComputerGame';
export type { ComputerGame } from './useComputerGame';

export const ComputerGameBar = React.memo((props: ComputerGame) => {
	const { playerColor, status, stop } = props;

	return (
		<div className={`cs-trainer is-computer is-${status}`}>
			<div className="cs-trainer-row">
				<span className="cs-trainer-chip">
					Playing against Stockfish as {playerColor === 'white' ? 'White' : 'Black'}
				</span>
				<span className="cs-trainer-status">{STATUS_TEXT[status]}</span>
				<button className="cs-trainer-button" onClick={stop} title="Stop playing">
					<X size={14} />
					Stop
				</button>
			</div>
		</div>
	);
});

ComputerGameBar.displayName = 'ComputerGameBar';
