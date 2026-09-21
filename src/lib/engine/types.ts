import { MoveClassification } from 'src/lib/classification';

export interface StockfishPositionEvaluation {
	fen: string;
	turn: 'w' | 'b';
	depth: number;
	score: { type: 'cp' | 'mate'; value: number } | null;
	scoreText: string;
	pv: string;
	pvSan: string;
	bestMove: string | null;
	bestMoveSan: string | null;
	ponder: string | null;
}

export interface StockfishMoveEvaluation {
	index: number;
	color: 'w' | 'b';
	san: string;
	before: StockfishPositionEvaluation;
	after: StockfishPositionEvaluation;
	swingCp: number | null;
	classification?: MoveClassification | null;
}

export interface StockfishReport {
	engine: string;
	depth: number;
	analyzedPlies: number;
	totalPlies: number;
	evaluations: StockfishMoveEvaluation[];
	whiteAccuracy?: number;
	blackAccuracy?: number;
	whitePerformanceRating?: number;
	blackPerformanceRating?: number;
}
