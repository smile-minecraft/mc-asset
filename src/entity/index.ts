export { ENTITY_FACE_NAMES } from "./box-uv.ts";
export type {
	EntityFaceReport,
	EntityInspectReport,
	EntityLayoutSummary,
	EntityPartReport,
} from "./inspect.ts";
export { entityLayoutSummary, inspectEntityLayout } from "./inspect.ts";
export {
	ENTITY_LAYOUT_FORMAT,
	ENTITY_LAYOUT_VERSION,
	MAX_ENTITY_PARTS,
	parseEntityLayoutDocument,
	resolveEntityLayout,
	resolveEntityLayoutDocument,
} from "./layout.ts";
export type { BuiltinEntityLayoutId } from "./layouts.ts";
export {
	canonicalEntityLayoutId,
	getEntityLayoutDocument,
	listEntityLayoutIds,
} from "./layouts.ts";
export type {
	EntityTemplate,
	EntityTemplateOptions,
	EntityTemplateRegion,
} from "./template.ts";
export {
	buildEntityTemplate,
	ENTITY_FACE_COLORS,
	ENTITY_FACE_SYMBOLS,
	entityRegionId,
} from "./template.ts";
export type {
	EntityFace,
	EntityFaceName,
	EntityLayer,
	EntityLayout,
	EntityLayoutDocument,
	EntityPart,
	EntityPartDocument,
	EntityRect,
	EntityTextureSize,
} from "./types.ts";
export type {
	EntityFinding,
	EntitySizeMismatchFinding,
	EntityTextureInput,
	EntityUnmappedPixelFinding,
	EntityValidateReport,
} from "./validate.ts";
export {
	MAX_REPORTED_UNMAPPED_PIXELS,
	validateEntityTexture,
} from "./validate.ts";
