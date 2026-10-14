export const MODEL_LIMITS = {
	maxFileBytes: 1_048_576,
	maxJsonDepth: 64,
	maxElements: 4096,
	maxTextures: 256,
	maxStringBytes: 4096,
	maxParentDepth: 32,
	maxOperations: 1000,
	maxVariants: 256,
	maxMultipartParts: 64,
	/** parent documents read for one inspect/validate call, across all layers */
	maxLoadedDocuments: 64,
} as const;
