import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/**
 * DeepSeek automatic context caching is a property of the API, not of a harness.
 * Pi already maps `prompt_cache_hit_tokens` to `usage.cacheRead`. Linco keeps the
 * system prompt and tool list stable so that prefix can hit.
 */
export function createDeepSeek(modelId: string): { model: Model<Api>; streamFn: StreamFn } {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", modelId);
  if (!model) {
    throw new Error(`DeepSeek model is not in the Pi catalog: ${modelId}. Try deepseek-flash or deepseek-v4-pro.`);
  }
  const streamFn: StreamFn = (requested, context, options) => models.streamSimple(requested, context, options);
  return { model, streamFn };
}
