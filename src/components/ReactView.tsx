import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
} from 'obsidian';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import {
	ChessRepertoireDataAdapter,
	ChessRepertoireFileData,
} from 'src/lib/storage';
import { ChessRepertoirePluginSettings } from './obsidian/SettingsTab';
import { ChessRepertoire } from './react/ChessRepertoire';

export class ReactView extends MarkdownRenderChild {
	root: ReactDOM.Root;
	source: string;
	app: App;
	ctx: MarkdownPostProcessorContext;
	settings: ChessRepertoirePluginSettings;
	data: ChessRepertoireFileData;
	dataAdapter: ChessRepertoireDataAdapter;
	onAnalyzeRepertoire?: (
		id: string,
		data: ChessRepertoireFileData,
		onUpdate?: (data: ChessRepertoireFileData) => void
	) => Promise<ChessRepertoireFileData | null>;
	onStockfishMove?: (fen: string) => Promise<string | null>;

	constructor(
		containerEL: HTMLElement,
		source: string,
		app: App,
		ctx: MarkdownPostProcessorContext,
		settings: ChessRepertoirePluginSettings,
		data: ChessRepertoireFileData,
		dataAdapter: ChessRepertoireDataAdapter,
		onAnalyzeRepertoire?: (
			id: string,
			data: ChessRepertoireFileData,
			onUpdate?: (data: ChessRepertoireFileData) => void
		) => Promise<ChessRepertoireFileData | null>,
		onStockfishMove?: (fen: string) => Promise<string | null>
	) {
		super(containerEL);
		this.source = source;
		this.app = app;
		this.ctx = ctx;
		this.settings = settings;
		this.data = data;
		this.dataAdapter = dataAdapter;
		this.onAnalyzeRepertoire = onAnalyzeRepertoire;
		this.onStockfishMove = onStockfishMove;
	}

	onload() {
		this.root = ReactDOM.createRoot(this.containerEl);
		this.root.render(
			<React.StrictMode>
				<ChessRepertoire
					source={this.source}
					app={this.app}
					ctx={this.ctx}
					containerEl={this.containerEl}
					pluginSettings={this.settings}
					chessRepertoireData={this.data}
					dataAdapter={this.dataAdapter}
					onAnalyzeRepertoire={this.onAnalyzeRepertoire}
					onStockfishMove={this.onStockfishMove}
				/>
			</React.StrictMode>
		);
	}

	onunload() {
		this.root.unmount();
	}
}
