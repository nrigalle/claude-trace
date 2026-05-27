interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
}

const RATES_USD_PER_MILLION: Readonly<Record<string, ModelRates>> = {
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  "claude-opus-4-1": { input: 15, output: 75, cache_read: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 },
  "claude-opus-4": { input: 15, output: 75, cache_read: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
  "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cache_read: 0.08, cache_write_5m: 1, cache_write_1h: 1.6 },
};

const OPUS_FALLBACK = RATES_USD_PER_MILLION["claude-opus-4-7"]!;
const SONNET_FALLBACK = RATES_USD_PER_MILLION["claude-sonnet-4-6"]!;
const HAIKU_FALLBACK = RATES_USD_PER_MILLION["claude-haiku-4-5"]!;

const PREFIX_RULES: ReadonlyArray<[string, ModelRates]> = Object.entries(RATES_USD_PER_MILLION)
  .sort(([a], [b]) => b.length - a.length);

const FAMILY_FALLBACKS: ReadonlyArray<[string, ModelRates]> = [
  ["opus", OPUS_FALLBACK],
  ["sonnet", SONNET_FALLBACK],
  ["haiku", HAIKU_FALLBACK],
];

const warnedUnknownModels = new Set<string>();

const warnOnce = (model: string, message: string): void => {
  if (warnedUnknownModels.has(model)) return;
  warnedUnknownModels.add(model);
  console.warn(message);
};

const ratesFor = (model: string): ModelRates => {
  const exact = RATES_USD_PER_MILLION[model];
  if (exact) return exact;
  for (const [prefix, rates] of PREFIX_RULES) {
    if (model.startsWith(prefix)) return rates;
  }
  for (const [family, rates] of FAMILY_FALLBACKS) {
    if (model.includes(family)) {
      warnOnce(
        model,
        `[claude-trace] unknown model "${model}", billing at ${family} fallback rates. Costs may be inaccurate.`,
      );
      return rates;
    }
  }
  warnOnce(model, `[claude-trace] unknown model "${model}", billing at Sonnet fallback rates.`);
  return SONNET_FALLBACK;
};

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_5m_input_tokens: number;
  readonly cache_creation_1h_input_tokens: number;
}

export const estimateUsageCost = (model: string, usage: Usage): number => {
  const r = ratesFor(model);
  return (
    (usage.input_tokens * r.input +
      usage.output_tokens * r.output +
      usage.cache_read_input_tokens * r.cache_read +
      usage.cache_creation_5m_input_tokens * r.cache_write_5m +
      usage.cache_creation_1h_input_tokens * r.cache_write_1h) /
    1_000_000
  );
};
