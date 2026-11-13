import {
	applyMat3,
	createRasterTarget,
	type FixedVec3,
	IDENTITY_MAT3,
	ISOMETRIC_DIRECTIONS,
	type Mat3,
	multiplyMat3,
	type ProjectedPoint,
	projectIsometric,
	projectOrthographic,
	type RasterTarget,
	type RgbaTexture,
	rasterizeQuad,
	rasterizeTriangle,
	rotationMatrix,
	SUBPIXEL,
	sixteenthTurnMatrix,
	toSubpixel,
} from "../../src/model/geometry/index.ts";
import type { ModelCase } from "./json-document-cases.ts";

const UNIT = 256;

function corner(x: number, y: number, z: number): FixedVec3 {
	return [x, y, z];
}

/** The eight corners of the unit cube in 1/256 model units. */
const CUBE_CORNERS: readonly FixedVec3[] = [
	corner(0, 0, 0),
	corner(UNIT, 0, 0),
	corner(UNIT, UNIT, 0),
	corner(0, UNIT, 0),
	corner(0, 0, UNIT),
	corner(UNIT, 0, UNIT),
	corner(UNIT, UNIT, UNIT),
	corner(0, UNIT, UNIT),
];

/** The six faces of the unit cube, as quads in submission order. */
const FACE_QUADS: readonly (readonly [number, number, number, number])[] = [
	[0, 1, 2, 3],
	[1, 5, 6, 2],
	[5, 4, 7, 6],
	[4, 0, 3, 7],
	[3, 2, 6, 7],
	[0, 4, 5, 1],
];

function worldCorners(
	matrix: Mat3,
	origin: readonly [number, number, number],
): FixedVec3[] {
	return CUBE_CORNERS.map((cornerPoint) => {
		const [x, y, z] = applyMat3(matrix, cornerPoint);
		const [ox, oy, oz] = origin;
		return [x + ox, y + oy, z + oz];
	});
}

function countFilledPixels(target: RasterTarget): number {
	let count = 0;
	for (let index = 3; index < target.pixels.length; index += 4) {
		if (target.pixels[index] !== 0) count += 1;
	}
	return count;
}

function polygonAreaSubpixel(
	points: readonly { readonly x: number; readonly y: number }[],
): number {
	let sum = 0;
	for (let index = 0; index < points.length; index += 1) {
		const current = points[index] as { x: number; y: number };
		const next = points[(index + 1) % points.length] as {
			x: number;
			y: number;
		};
		sum += current.x * next.y - next.x * current.y;
	}
	return Math.abs(sum) / 2;
}

function makeCheckerTexture(): RgbaTexture {
	const size = 16;
	const pixels = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const offset = (y * size + x) * 4;
			const light = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
			pixels[offset] = light ? 214 : 45;
			pixels[offset + 1] = light ? 120 : 73;
			pixels[offset + 2] = light ? 32 : 145;
			pixels[offset + 3] = 255;
		}
	}
	return { width: size, height: size, pixels };
}

/** 32-bit FNV-1a over the bytes of a buffer; an independent cross-check of the render. */
function hashRgba(pixels: Uint8Array): number {
	let hash = 0x811c9dc5 >>> 0;
	for (let index = 0; index < pixels.length; index += 1) {
		hash = Math.imul(hash ^ (pixels[index] as number), 0x01000193);
	}
	return hash >>> 0;
}

/**
 * The acceptance render: two unit cubes in one isometric view. The first
 * rotates 22.5 degrees about y and the second 45 degrees about x; both go
 * through the sixteenth-turn table. Cube B sits 520 units (i.e. 2.03 units)
 * to the east of cube A so the two cubes do not overlap in depth.
 */
function rotatedCubesRender(): RasterTarget {
	const scale = 256; // exactly 16 px per model unit
	const cubeA = worldCorners(rotationMatrix("y", 22500), [0, 0, 0]);
	const cubeB = worldCorners(rotationMatrix("x", 45000), [520, 0, 0]);
	const extent = [...cubeA, ...cubeB].map((point) => projectIsometric(point));
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const point of extent) {
		if (point.x < minX) minX = point.x;
		if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.y > maxY) maxY = point.y;
	}
	const m = (value: number) => Math.floor((value * scale) / UNIT);
	const minSubX = m(minX);
	const minSubY = m(minY);
	const viewport = {
		scale,
		offsetX: -minSubX + 2 * SUBPIXEL,
		offsetY: -minSubY + 2 * SUBPIXEL,
	};
	const spanX = m(maxX) - minSubX;
	const spanY = m(maxY) - minSubY;
	const width = Math.ceil((spanX + 4 * SUBPIXEL) / SUBPIXEL);
	const height = Math.ceil((spanY + 4 * SUBPIXEL) / SUBPIXEL);
	const texture = makeCheckerTexture();
	const target = createRasterTarget(width, height);
	const uvCorners = [
		[0, 0],
		[texture.width * 256, 0],
		[texture.width * 256, texture.height * 256],
		[0, texture.height * 256],
	] as const;
	for (const world of [cubeA, cubeB]) {
		for (const quad of FACE_QUADS) {
			const vertices = quad.map((index, cornerIndex) => {
				const sub = toSubpixel(
					projectIsometric(world[index] as FixedVec3),
					viewport,
				);
				const uv = uvCorners[cornerIndex] as readonly [number, number];
				return { ...sub, u: uv[0], v: uv[1] };
			});
			rasterizeQuad(
				target,
				vertices[0],
				vertices[1],
				vertices[2],
				vertices[3],
				{ texture },
			);
		}
	}
	return target;
}

export const GEOMETRY_CASES: ModelCase[] = [
	{
		name: "fixed point: the identity rotation leaves a vector unchanged",
		run(check) {
			check.deepEqual(applyMat3(IDENTITY_MAT3, [UNIT, 2 * UNIT, -3 * UNIT]), [
				UNIT,
				2 * UNIT,
				-3 * UNIT,
			]);
			const quarter = sixteenthTurnMatrix("y", 4);
			check.deepEqual(multiplyMat3(IDENTITY_MAT3, quarter), quarter);
			check.deepEqual(multiplyMat3(quarter, IDENTITY_MAT3), quarter);
		},
	},
	{
		name: "22.5-degree steps take the precomputed integer table",
		run(check) {
			// cos(22.5 deg) in Q16 = 60547/65536 and sin(22.5 deg) = 25080/65536,
			// so a unit x vector lands on [round(60547/256), 0, -round(25080/256)].
			check.deepEqual(
				applyMat3(sixteenthTurnMatrix("y", 1), [UNIT, 0, 0]),
				[237, 0, -98],
			);
			// Every multiple of 90 degrees reproduces exactly.
			check.deepEqual(applyMat3(sixteenthTurnMatrix("y", 4), [UNIT, 0, 0]), [
				0,
				0,
				-UNIT,
			]);
			check.deepEqual(applyMat3(sixteenthTurnMatrix("y", 8), [UNIT, 0, 0]), [
				-UNIT,
				0,
				0,
			]);
			check.deepEqual(applyMat3(sixteenthTurnMatrix("y", 12), [UNIT, 0, 0]), [
				0,
				0,
				UNIT,
			]);
			check.deepEqual(applyMat3(sixteenthTurnMatrix("y", 16), [UNIT, 0, 0]), [
				UNIT,
				0,
				0,
			]);
			// The dispatcher takes the table for exact multiples of 22.5 degrees.
			for (let step = 0; step < 16; step += 1) {
				check.deepEqual(
					rotationMatrix("y", 22500 * step),
					sixteenthTurnMatrix("y", step),
					`rotationMatrix(22500 * ${step})`,
				);
			}
			// Negative angles wrap through the table instead of going negative.
			check.deepEqual(
				rotationMatrix("y", -22500),
				sixteenthTurnMatrix("y", 15),
			);
			check.deepEqual(rotationMatrix("y", 360000), IDENTITY_MAT3);
		},
	},
	{
		name: "arbitrary angles land on the independently computed reference within 1/256",
		run(check) {
			// Reference values computed with double precision sine and cosine,
			// rounded to the nearest 1/256 unit, fixed in this file.
			const references: Record<string, readonly (readonly number[])[]> = {
				"y:17000": [
					[0, 0, 0],
					[245, 0, -75],
					[245, 256, -75],
					[0, 256, 0],
					[75, 0, 245],
					[320, 0, 170],
					[320, 256, 170],
					[75, 256, 245],
				],
				"x:-33300": [
					[0, 0, 0],
					[256, 0, 0],
					[256, 214, -141],
					[0, 214, -141],
					[0, 141, 214],
					[256, 141, 214],
					[256, 355, 73],
					[0, 355, 73],
				],
			};
			const cases = [
				{ axis: "y" as const, milliDegrees: 17000 },
				{ axis: "x" as const, milliDegrees: -33300 },
			];
			for (const entry of cases) {
				const expected = references[
					`${entry.axis}:${entry.milliDegrees}`
				] as readonly (readonly number[])[];
				const matrix = rotationMatrix(entry.axis, entry.milliDegrees);
				for (let index = 0; index < CUBE_CORNERS.length; index += 1) {
					const actual = applyMat3(matrix, CUBE_CORNERS[index] as FixedVec3);
					for (let axis = 0; axis < 3; axis += 1) {
						const got = actual[axis] as number;
						const wanted = expected[index]?.[axis] as number;
						check.ok(
							Math.abs(got - wanted) <= 1,
							`${entry.axis} ${entry.milliDegrees} corner ${index} axis ${axis}: expected ${wanted} +/- 1, got ${got}`,
						);
					}
				}
			}
		},
	},
	{
		name: "orthographic views project like the existing panels",
		run(check) {
			const front = projectOrthographic("front", corner(123, 456, 789));
			check.deepEqual(
				{ x: front.x, y: front.y, depth: front.depth },
				{ x: -123, y: -456, depth: -789 },
			);
			const right = projectOrthographic("right", corner(123, 456, 789));
			check.deepEqual(
				{ x: right.x, y: right.y, depth: right.depth },
				{ x: -789, y: -456, depth: 123 },
			);
			const top = projectOrthographic("top", corner(123, 456, 789));
			check.deepEqual(
				{ x: top.x, y: top.y, depth: top.depth },
				{ x: 123, y: 789, depth: 456 },
			);
			const sub = toSubpixel(
				{ x: -512, y: 768, depth: -90 } satisfies ProjectedPoint,
				{ scale: 256, offsetX: 1024, offsetY: 512 },
			);
			check.deepEqual(sub, { x: 512, y: 1280, z: -90 });
			// 257 * 128 / 256 = 128.5, ties go away from zero.
			const rounded = toSubpixel(
				{ x: 771, y: 1285, depth: 0 } satisfies ProjectedPoint,
				{ scale: 128, offsetX: 0, offsetY: 0 },
			);
			check.deepEqual(rounded, { x: 386, y: 643, z: 0 });
		},
	},
	{
		name: "isometric views: unit vectors, directions, and depth all match the 2:1 projection",
		run(check) {
			const unitX = projectIsometric(corner(UNIT, 0, 0));
			check.deepEqual(
				{ x: unitX.x, y: unitX.y, depth: unitX.depth },
				{ x: 2 * UNIT, y: UNIT, depth: UNIT },
			);
			const unitY = projectIsometric(corner(0, UNIT, 0));
			check.deepEqual(
				{ x: unitY.x, y: unitY.y, depth: unitY.depth },
				{ x: 0, y: -2 * UNIT, depth: UNIT },
			);
			const unitZ = projectIsometric(corner(0, 0, UNIT));
			check.deepEqual(
				{ x: unitZ.x, y: unitZ.y, depth: unitZ.depth },
				{ x: -2 * UNIT, y: UNIT, depth: UNIT },
			);
			check.equal(projectIsometric(corner(UNIT, UNIT, UNIT)).depth, 3 * UNIT);
			check.deepEqual(
				[...ISOMETRIC_DIRECTIONS],
				["south-east", "south-west", "north-west", "north-east"],
			);
			// A named direction is one quarter turn per step composed with the
			// base projection, so the two caller styles agree.
			const swDirect = projectIsometric(corner(UNIT, 0, 0), "south-west");
			const swComposed = projectIsometric(
				applyMat3(sixteenthTurnMatrix("y", 4), corner(UNIT, 0, 0)),
			);
			check.deepEqual(
				{ x: swDirect.x, y: swDirect.y, depth: swDirect.depth },
				{ x: swComposed.x, y: swComposed.y, depth: swComposed.depth },
			);
			const neDirect = projectIsometric(corner(0, 0, UNIT), "north-east");
			const neComposed = projectIsometric(
				applyMat3(sixteenthTurnMatrix("y", 12), corner(0, 0, UNIT)),
			);
			check.deepEqual(
				{ x: neDirect.x, y: neDirect.y, depth: neDirect.depth },
				{ x: neComposed.x, y: neComposed.y, depth: neComposed.depth },
			);
		},
	},
	{
		name: "isometric unit cube projects three equal-area faces with a 2:1 top face",
		run(check) {
			const viewport = { scale: 256, offsetX: 2048, offsetY: 1536 };
			const faces: readonly (readonly [number, number, number, number])[] = [
				[3, 2, 6, 7], // top
				[1, 2, 6, 5], // east
				[4, 5, 6, 7], // south
			];
			for (const quad of faces) {
				const points = quad.map((index) =>
					toSubpixel(
						projectIsometric(CUBE_CORNERS[index] as FixedVec3),
						viewport,
					),
				);
				const area = polygonAreaSubpixel(points);
				check.equal(area, 262_144, "projected face area, in subpixels squared");
				for (const point of points) {
					check.equal(point.x % SUBPIXEL, 0, "vertex lands on the pixel grid");
					check.equal(point.y % SUBPIXEL, 0, "vertex lands on the pixel grid");
				}
			}
			const topPoints = (
				faces[0] as readonly [number, number, number, number]
			).map((index) => projectIsometric(CUBE_CORNERS[index] as FixedVec3));
			const xs = topPoints.map((point) => point.x);
			const ys = topPoints.map((point) => point.y);
			const spanX = Math.max(...xs) - Math.min(...xs);
			const spanY = Math.max(...ys) - Math.min(...ys);
			check.equal(spanX, 2 * spanY, "top face keeps a 2:1 aspect ratio");
			check.equal(spanX, 4 * UNIT);
			for (const quad of faces) {
				const target = createRasterTarget(512, 512);
				const vertices = quad.map((index) => {
					const sub = toSubpixel(
						projectIsometric(CUBE_CORNERS[index] as FixedVec3),
						viewport,
					);
					return { ...sub, u: 0, v: 0 };
				});
				rasterizeQuad(
					target,
					vertices[0],
					vertices[1],
					vertices[2],
					vertices[3],
					{
						color: [200, 100, 50, 255],
					},
				);
				check.equal(
					countFilledPixels(target),
					1024,
					"each visible face fills exactly 1024 pixels",
				);
			}
		},
	},
	{
		name: "rasteriser fills an axis-aligned quad exactly once",
		run(check) {
			const target = createRasterTarget(48, 48);
			const vertices = [
				{ x: 4 * SUBPIXEL, y: 4 * SUBPIXEL, z: 100, u: 0, v: 0 },
				{ x: 36 * SUBPIXEL, y: 4 * SUBPIXEL, z: 100, u: 0, v: 0 },
				{ x: 36 * SUBPIXEL, y: 36 * SUBPIXEL, z: 100, u: 0, v: 0 },
				{ x: 4 * SUBPIXEL, y: 36 * SUBPIXEL, z: 100, u: 0, v: 0 },
			] as const;
			rasterizeQuad(
				target,
				vertices[0],
				vertices[1],
				vertices[2],
				vertices[3],
				{
					color: [10, 20, 30, 255],
				},
			);
			check.equal(countFilledPixels(target), 32 * 32);
			check.equal(target.pixels[0], 0, "background stays untouched");
			check.equal(target.depth[4 * 48 + 4], 100);
		},
	},
	{
		name: "rasteriser never double-paints the diagonal of a split quad",
		run(check) {
			const target = createRasterTarget(64, 64);
			const vertices = [
				{ x: 0, y: 0, z: 50, u: 0, v: 0 },
				{ x: 48 * SUBPIXEL, y: 0, z: 50, u: 0, v: 0 },
				{ x: 48 * SUBPIXEL, y: 48 * SUBPIXEL, z: 50, u: 0, v: 0 },
				{ x: 0, y: 48 * SUBPIXEL, z: 50, u: 0, v: 0 },
			] as const;
			rasterizeQuad(
				target,
				vertices[0],
				vertices[1],
				vertices[2],
				vertices[3],
				{ color: [120, 140, 160, 128] },
				{ blend: "alpha" },
			);
			let wrong = 0;
			for (let index = 0; index < target.pixels.length; index += 4) {
				const alpha = target.pixels[index + 3] as number;
				if (alpha === 0) continue;
				if (alpha !== 128) wrong += 1;
				// Straight alpha keeps the colour of a half-transparent fragment
				// over a transparent pixel; a premultiplied blend would halve it.
				if (
					target.pixels[index] !== 120 ||
					target.pixels[index + 1] !== 140 ||
					target.pixels[index + 2] !== 160
				) {
					wrong += 1;
				}
			}
			check.equal(
				wrong,
				0,
				"no pixel received the same half-alpha paint twice",
			);
			check.equal(countFilledPixels(target), 48 * 48);
		},
	},
	{
		name: "rasteriser resolves overlapping triangles by depth, including ties",
		run(check) {
			const triangle = (x0: number, x1: number, z: number) =>
				[
					{ x: x0 * SUBPIXEL, y: 4 * SUBPIXEL, z, u: 0, v: 0 },
					{ x: x1 * SUBPIXEL, y: 4 * SUBPIXEL, z, u: 0, v: 0 },
					{ x: ((x0 + x1) * SUBPIXEL) / 2, y: 40 * SUBPIXEL, z, u: 0, v: 0 },
				] as const;
			const far = triangle(2, 30, 10);
			const near = triangle(8, 28, 20);
			const draw = (target: RasterTarget) => {
				rasterizeTriangle(target, far[0], far[1], far[2], {
					color: [255, 0, 0, 255],
				});
				rasterizeTriangle(target, near[0], near[1], near[2], {
					color: [0, 0, 255, 255],
				});
			};
			const targetA = createRasterTarget(48, 48);
			draw(targetA);
			const targetB = createRasterTarget(48, 48);
			rasterizeTriangle(targetB, near[0], near[1], near[2], {
				color: [0, 0, 255, 255],
			});
			rasterizeTriangle(targetB, far[0], far[1], far[2], {
				color: [255, 0, 0, 255],
			});
			const shared = (20 * 48 + 16) * 4;
			check.equal(
				targetA.pixels[shared],
				0,
				"the shared pixel keeps the nearer colour",
			);
			check.equal(targetA.pixels[shared + 2], 255);
			check.equal(
				targetB.pixels[shared],
				0,
				"the shared pixel keeps the nearer colour with the opposite draw order",
			);
			check.equal(targetB.pixels[shared + 2], 255);
			const targetC = createRasterTarget(48, 48);
			rasterizeTriangle(targetC, far[0], far[1], far[2], {
				color: [255, 0, 0, 255],
			});
			rasterizeTriangle(targetC, far[0], far[1], far[2], {
				color: [0, 255, 0, 255],
			});
			check.equal(
				targetC.pixels[shared + 1],
				255,
				"on an exact depth tie the later draw wins",
			);
		},
	},
	{
		name: "rasteriser skips transparent fragments before the depth test",
		run(check) {
			const target = createRasterTarget(16, 16);
			const texture: RgbaTexture = {
				width: 1,
				height: 1,
				pixels: new Uint8Array([9, 8, 7, 0]),
			};
			const vertices = [
				{ x: 0, y: 0, z: 7, u: 0, v: 0 },
				{ x: 16 * SUBPIXEL, y: 0, z: 7, u: 0, v: 0 },
				{ x: 0, y: 16 * SUBPIXEL, z: 7, u: 0, v: 0 },
			] as const;
			rasterizeTriangle(target, vertices[0], vertices[1], vertices[2], {
				texture,
			});
			check.equal(countFilledPixels(target), 0);
			check.equal(target.depth[0], -2147483648);
		},
	},
	{
		name: "rasteriser blends with integer src-over when asked",
		run(check) {
			const target = createRasterTarget(1, 1);
			// The pixel starts as opaque black; the triangle's depth ties with
			// the stored one, so the blend is exercised instead of depth-rejecting.
			target.depth[0] = 5;
			target.pixels[0] = 0;
			target.pixels[1] = 0;
			target.pixels[2] = 0;
			target.pixels[3] = 255;
			const vertices = [
				{ x: 0, y: 0, z: 5, u: 0, v: 0 },
				{ x: 64 * SUBPIXEL, y: 0, z: 5, u: 0, v: 0 },
				{ x: 0, y: 64 * SUBPIXEL, z: 5, u: 0, v: 0 },
			] as const;
			rasterizeTriangle(
				target,
				vertices[0],
				vertices[1],
				vertices[2],
				{ color: [200, 100, 50, 128] },
				{ blend: "alpha" },
			);
			// srcWeight = 32640, dstWeight = 255 * 127 = 32385, so the divisor
			// (outAlphaScaled) is 65025 and (200, 100, 50) rounds to (100, 50, 25);
			// the resulting alpha stays 255.
			check.deepEqual(Array.from(target.pixels), [100, 50, 25, 255]);
		},
	},
	{
		name: "rasteriser keeps straight alpha when blending translucent over translucent",
		run(check) {
			const target = createRasterTarget(1, 1);
			// Half-transparent blue underneath; draw half-transparent red on top.
			target.depth[0] = 5;
			target.pixels[0] = 0;
			target.pixels[1] = 0;
			target.pixels[2] = 255;
			target.pixels[3] = 128;
			const vertices = [
				{ x: 0, y: 0, z: 5, u: 0, v: 0 },
				{ x: 64 * SUBPIXEL, y: 0, z: 5, u: 0, v: 0 },
				{ x: 0, y: 64 * SUBPIXEL, z: 5, u: 0, v: 0 },
			] as const;
			rasterizeTriangle(
				target,
				vertices[0],
				vertices[1],
				vertices[2],
				{ color: [255, 0, 0, 128] },
				{ blend: "alpha" },
			);
			// srcWeight 32640, dstWeight 16256, outAlphaScaled 48896:
			// red = divRound(8323200 / 48896) = 170, blue = 85, alpha = 192.
			check.deepEqual(Array.from(target.pixels), [170, 0, 85, 192]);
		},
	},
	{
		name: "createRasterTarget zeroes pixels and depth",
		run(check) {
			const target = createRasterTarget(8, 8);
			check.equal(target.width, 8);
			check.equal(target.height, 8);
			check.equal(target.pixels.length, 8 * 8 * 4);
			check.ok(target.pixels.every((byte) => byte === 0));
			check.ok(target.depth.every((cell) => cell === -2147483648));
		},
	},
	{
		name: "two rotated cubes render to the fixed hash on Bun and the Node runner",
		run(check) {
			const target = rotatedCubesRender();
			check.equal(target.width, 119);
			check.equal(target.height, 119);
			check.equal(
				countFilledPixels(target),
				5367,
				"pixels covered by the two rotated cubes",
			);
			check.equal(
				hashRgba(target.pixels).toString(16).padStart(8, "0"),
				"b76434c3",
				"fixed hash of the two-cube render",
			);
			const again = rotatedCubesRender();
			check.deepEqual(Array.from(again.pixels), Array.from(target.pixels));
			check.deepEqual(Array.from(again.depth), Array.from(target.depth));
		},
	},
];
