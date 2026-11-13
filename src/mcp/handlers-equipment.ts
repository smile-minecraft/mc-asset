import { Buffer } from "node:buffer";
import { runEquipmentRequest } from "../cli/cmd-equipment.ts";
import {
	resolveVersionTarget,
	versionReportShape,
} from "../cli/version-options.ts";
import { McAssetError } from "../core/errors.ts";
import type { EquipmentLayerRequest } from "../equipment/index.ts";
import { errorResult, type McpTextResult } from "./handlers.ts";
import type { EquipmentAssetInput } from "./schema.ts";

/** `true` writes `dyeable: {}`, an object carries `color_when_undyed`. */
function dyeableOf(
	value: EquipmentAssetInput["layers"][number]["dyeable"],
): EquipmentLayerRequest["dyeable"] {
	if (value === undefined || value === false) {
		return undefined;
	}
	if (value === true) {
		return {};
	}
	return value.colorWhenUndyed === undefined
		? {}
		: { colorWhenUndyed: value.colorWhenUndyed };
}

/**
 * equipment_asset: the same `runEquipmentRequest` core the CLI calls, so the
 * written bytes and the embedded artifacts are identical. Without `outputDir`
 * the definition text and every template (pngBase64 plus sourceText) embed and
 * nothing touches disk; an unknown layer type, a layer type without a verified
 * layout, or a target format without equipment definitions refuses before any
 * output path is planned.
 */
export async function handleEquipmentAsset(
	input: EquipmentAssetInput,
): Promise<McpTextResult> {
	try {
		const target = resolveVersionTarget({
			...(input.minecraftVersion === undefined
				? {}
				: { minecraftVersion: input.minecraftVersion }),
			...(input.resourcePackVersion === undefined
				? {}
				: { resourcePackVersion: input.resourcePackVersion }),
		});
		if (target.packFormat === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"equipment_asset needs minecraftVersion or resourcePackVersion, because the definition path depends on the target format.",
			);
		}
		const layers: EquipmentLayerRequest[] = input.layers.map((layer) => {
			const dyeable = dyeableOf(layer.dyeable);
			return {
				type: layer.type,
				...(layer.texture === undefined ? {} : { texture: layer.texture }),
				...(dyeable === undefined ? {} : { dyeable }),
				...(layer.usePlayerTexture === true ? { usePlayerTexture: true } : {}),
			};
		});
		const outcome = await runEquipmentRequest({
			namespace: input.namespace,
			id: input.id,
			packFormat: target.packFormat,
			layers,
			template: input.template !== false,
			fill: input.fill !== false,
			...(input.outputDir === undefined ? {} : { outputDir: input.outputDir }),
			force: input.force === true,
			mkdir: input.mkdir === true,
			requireOutput: false,
			version: versionReportShape(target),
		});
		const content: McpTextResult["content"] = [
			{ type: "text", text: JSON.stringify({ ...outcome.result }) },
		];
		for (const png of outcome.pngs) {
			content.push({
				type: "image",
				data: Buffer.from(png).toString("base64"),
				mimeType: "image/png",
			});
		}
		return { content };
	} catch (error) {
		return errorResult(error);
	}
}
