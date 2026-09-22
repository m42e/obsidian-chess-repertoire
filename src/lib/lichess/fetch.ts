const validDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const dayKey = (date: Date): string =>
	[
		String(date.getFullYear()).padStart(4, '0'),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0'),
	].join('-');

export const dayBefore = (value: string): string => {
	if (!validDay(value)) return value;

	const [year, month, day] = value.split('-').map(Number);
	return dayKey(new Date(year, month - 1, day - 1));
};

export const dayStart = (value: string): number | null => {
	if (!validDay(value)) return null;

	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(year, month - 1, day);
	return Number.isNaN(date.getTime()) ? null : date.getTime();
};

export const shouldImportGame = (date: Date, lastFetchedDay: string): boolean =>
	!validDay(lastFetchedDay) || dayKey(date) >= lastFetchedDay;

export const LICHESS_PAGE_SIZE = 300;

export const gamesUrlForUser = (
	username: string,
	sinceDay: string,
	until?: number
): string => {
	const params = new URLSearchParams({
		max: String(LICHESS_PAGE_SIZE),
		pgnInJson: 'true',
		clocks: 'true',
		evals: 'true',
		accuracy: 'true',
		opening: 'true',
		sort: 'dateDesc',
	});
	const since = dayStart(sinceDay);
	if (since !== null) params.set('since', String(since));
	if (until !== undefined) params.set('until', String(until));

	return `https://lichess.org/api/games/user/${encodeURIComponent(
		username
	)}?${params.toString()}`;
};

export const parseNdjson = (text: string): Record<string, unknown>[] =>
	text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error(`Lichess returned invalid game data on line ${index + 1}`);
			return value as Record<string, unknown>;
		});
