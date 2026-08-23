export {
	type CompressOutcome,
	compressToolOutput,
	invalidateHealth,
	isValidHash,
	originOf,
	proxyHealthy,
	retrieveOriginal,
	saveOriginals,
	startProxy,
	stopSpawnedProxies,
} from "./client.js";
export {
	DEFAULT_HEADROOM_CONFIG,
	DEFAULT_PROTECTED_TOOLS,
	resolveHeadroom,
	type HeadroomSettings,
	type ResolvedHeadroomConfig,
} from "./config.js";
export { HeadroomStage, type HeadroomApplyResult, type HeadroomStats, type StageMessage } from "./stage.js";
