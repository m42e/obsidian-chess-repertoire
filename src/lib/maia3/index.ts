import { Maia3 as Maia3Web } from 'maia3-js/web';

export class Maia3Player {
	private engine: Maia3Web | null = null;
	private ready: Promise<Maia3Web> | null = null;

	constructor(
		private readonly modelBytes: ArrayBuffer,
		private readonly wasmPaths?: string
	) {}

	private async initialize(): Promise<Maia3Web> {
		if (this.engine) return this.engine;
		if (this.ready) return this.ready;

		const engine = new Maia3Web({
			variant: '5m',
			modelBytes: this.modelBytes,
			temperature: 0,
			topK: 0,
			numThreads: 1,
			wasmPaths: this.wasmPaths,
		});
		const ready = engine.load().then(() => {
			this.engine = engine;
			return engine;
		});
		this.ready = ready.catch((error: unknown) => {
			this.ready = null;
			throw error;
		});

		return this.ready;
	}

	async bestMove(fen: string, elo: number): Promise<string | null> {
		const result = await (
			await this.initialize()
		).predict({
			fen,
			selfElo: elo,
			oppoElo: elo,
			temperature: 0,
			topK: 0,
		});

		return result.bestMove || null;
	}

	async shutdown(): Promise<void> {
		const engine = this.engine;
		this.engine = null;
		this.ready = null;
		await engine?.close();
	}
}