interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

const RATES_USD_PER_MILLION: Readonly<Record<string, ModelRates>> = {
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

const fallback = (model: string): ModelRates => {
  if (model.includes("opus")) return RATES_USD_PER_MILLION["claude-opus-4-7"]!;
  if (model.includes("sonnet")) return RATES_USD_PER_MILLION["claude-sonnet-4-6"]!;
  if (model.includes("haiku")) return RATES_USD_PER_MILLION["claude-haiku-4-5"]!;
  return { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
};

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

export const estimateUsageCost = (model: string, usage: Usage): number => {
  const r = RATES_USD_PER_MILLION[model] ?? fallback(model);
  return (
    (usage.input_tokens * r.input +
      usage.output_tokens * r.output +
      usage.cache_read_input_tokens * r.cache_read +
      usage.cache_creation_input_tokens * r.cache_write) /
    1_000_000
  );
};
