/**
 * Renderer/Effects/Level99Bubble.js
 *
 * Level 99 aura bubble sparkle (EF_LEVEL99_3)
 * Implements the Blue Level99_3 behavior with 4 columns of camera-facing quads.
 *
 * Reference behavior (flag1=1, texture=whitelight, radius=2.4, speed v=0.15):
 * - 4 emitter columns, each with 4 anchors (B_pre, B_now, T_pre, T_now)
 * - Each anchor has X,Z jitter: x += kx*sin(phaseA), z += kz*sin(phaseB)
 * - Anchors drift downward at constant speed v
 * - Reset when y < -30: x=z=0, y=rand[0,99], reseed phases
 * - Billboard unit square of radius 2.4 facing camera
 * - Alpha: clamp(250 + 25*(y + 20), 0, 250)
 * - Color: (80,80,255), additive blend
 *
 * Optimization — WebGL2 instancing:
 * - _buffer: static STATIC_DRAW quad (6 verts, aCorner vec2 + aUV vec2)
 * - _instanceBuffer: DYNAMIC_DRAW, MAX_INSTANCES * 4 floats
 *   stride = [anchorX, anchorY, anchorZ, zIndex]
 *   zIndex < 0 signals dead/skip in the vertex shader
 * - One bufferSubData + drawArraysInstanced per pass per effect (vs 16 per anchor)
 * - Billboard rotation ported to GLSL (uBillboard uniform)
 * - Alpha computed in vertex shader; dead instances discarded via offscreen position
 */

import _vertexShader from './Level99Bubble.vs?raw';
import _fragmentShader from './Level99Bubble.fs?raw';
import WebGL from 'Utils/WebGL.js';
import Client from 'Core/Client.js';
import Camera from 'Renderer/Camera.js';
import Altitude from 'Renderer/Map/Altitude.js';
import SpriteRenderer from 'Renderer/SpriteRenderer.js';

const DEG_TO_RAD = Math.PI / 180;
const GAME_TO_WORLD = 0.1 * 2.2;
const NUM_COLUMNS = 4; // 4 emitter columns
const ANCHORS_PER_COL = 4; // B_pre, B_now, T_pre, T_now
const BASE_LIFT = 0.05;
const DEBUG_UI_ID = 'lvl99bubble-debug';

const REF_RADIUS = 2.4; // Billboard radius
const REF_SPEED = 0.15; // Fall speed per frame in robrowser units
const REF_DRIFT_K = 0.15; // Jitter amplitude (±0.15)
const REF_SEED_MAX = 99; // Max spawn height
const REF_RESET_Y = -30; // Reset threshold
const REF_ALPHA_OFFSET = 20; // Alpha formula offset
const REF_ALPHA_GAIN = 30; // Alpha formula gain (default request)

// Maximum instances: 4 columns × 4 anchors = 16
const MAX_INSTANCES = 16;
// Floats per instance in _instanceBuffer: anchorX, anchorY, anchorZ, zIndex
const INSTANCE_STRIDE = 4;

// Sign patterns for the 4 anchors per column
// B_pre: (+kx, +kz), B_now: (-kx, -kz), T_pre: (+kx, -kz), T_now: (-kx, +kz)
const ANCHOR_SIGNS = [
	{ kx: 1, kz: 1 }, // B_pre
	{ kx: -1, kz: -1 }, // B_now
	{ kx: 1, kz: -1 }, // T_pre
	{ kx: -1, kz: 1 } // T_now
];

// Phase index pairs for each anchor (pa, pb from reference)
// B_pre: (0,2), B_now: (4,6), T_pre: (8,10), T_now: (12,14)
const ANCHOR_PHASE_OFFSETS = [
	{ pa: 0, pb: 2 },
	{ pa: 4, pb: 6 },
	{ pa: 8, pb: 10 },
	{ pa: 12, pb: 14 }
];

// Runtime-tunable config (temporary debug UI below)
const debugConfig = {
	scaleMult: 0.6,
	seedMax: REF_SEED_MAX,
	ghostSeedMax: 60,
	showRedBg: false,
	bgAlpha: 0.3,
	bgRadiusFactor: 2.0,
	fallSpeedMult: 1.0,
	respawnDepthMult: 1.0,
	alphaOffset: REF_ALPHA_OFFSET,
	alphaGain: REF_ALPHA_GAIN,
	floorLimit: Math.abs(REF_RESET_Y)
};

// Module-level WebGL resources (shared across all instances)
let _program;
let _buffer; // static quad VBO
let _instanceBuffer; // dynamic instance VBO (shared, written per-effect before draw)

// Scratch Float32Array for instance data upload — reused every frame
const _instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_STRIDE);

// Scratch VBO for renderBackground debug quads (legacy path, kept isolated)
let _bgBuffer;
const _bgQuadData = new Float32Array(30); // 6 verts * (3 pos + 2 uv)

function randRange(min, max) {
	return min + Math.random() * (max - min);
}

function wrapDegrees(angle) {
	angle %= 360;
	if (angle < 0) {
		angle += 360;
	}
	return angle;
}

/**
 * Advance a phase angle toward a random target, reseed when reached.
 * Returns { angle, target }
 */
function advancePhase(current, target, stepScale = 1.0) {
	let diff = target - current;
	diff = ((diff + 540) % 360) - 180; // Wrap to [-180,180]
	const step = (2 + Math.random()) * stepScale; // 2–3 degrees/frame * stepScale

	if (Math.abs(diff) <= step) {
		current = target;
		target = randRange(0, 360);
	} else {
		current = wrapDegrees(current + Math.sign(diff) * step);
	}

	return { angle: current, target: target };
}

function pickColor(flag1) {
	if (flag1 === 1) {
		// Exact blue from reference (80,80,255)
		return { r: 80 / 255, g: 80 / 255, b: 255 / 255 };
	}
	if (flag1 === 11 || flag1 === 3) {
		// Ghost gray
		return { r: 0.85, g: 0.85, b: 0.85 };
	}
	return { r: 1.0, g: 1.0, b: 1.0 };
}

/**
 * Create an anchor with initial state
 */
function createAnchor(isGhost, seedMaxUnits) {
	return {
		x: 0,
		y: randRange(0, seedMaxUnits),
		z: 0
	};
}

/**
 * Level99Bubble constructor
 *
 * @param {vec3} position - world grid position (entity position reference)
 * @param {string} textureName - texture filename
 * @param {number} tick - start tick (unused, kept for parity)
 * @param {number} flag1 - tint selector (0 white, 1 blue, 11 ghost)
 */
class Level99Bubble {
	constructor(position, textureName, tick, flag1) {
		this.position = position;
		this.textureName = textureName || 'whitelight.tga';
		this.tick = tick || 0;
		this._lastTick = tick || Date.now();
		// Default to flag1 = 1 (blue variant) unless explicitly overridden
		this.flag1 = flag1 === 0 || flag1 ? flag1 : 1;

		const isGhost = this.flag1 === 11 || this.flag1 === 3;

		// Reference values in robrowser units
		this.baseRadius = this.flag1 === 1 ? REF_RADIUS : isGhost ? 3.2 : 0.8;
		this.fallSpeed = isGhost ? 0.6 : REF_SPEED; // v per frame in robrowser units
		this.seedMax = isGhost ? debugConfig.ghostSeedMax : debugConfig.seedMax;
		this.resetY = isGhost ? -debugConfig.ghostSeedMax : REF_RESET_Y;
		this.driftK = REF_DRIFT_K; // Jitter amplitude
		this.color = pickColor(this.flag1);
		this.isGhost = isGhost;
		this.passCount = this.flag1 === 1 ? 2 : 1;

		// Initialize columns (emitters)
		this.columns = [];
		const numCols = isGhost ? 1 : NUM_COLUMNS; // Ghost uses only 1 column
		for (let ec = 0; ec < numCols; ec++) {
			const column = {
				life: true,
				anchors: [],
				// 16 phases per column: pairs for each anchor's X and Z
				phases: new Float32Array(16),
				phaseTargets: new Float32Array(16)
			};

			// Initialize phases with random values [0, 360)
			for (let p = 0; p < 16; p++) {
				column.phases[p] = randRange(0, 360);
				column.phaseTargets[p] = randRange(0, 360);
			}

			// Create 4 anchors per column
			for (let a = 0; a < ANCHORS_PER_COL; a++) {
				const anchor = createAnchor(isGhost, this.seedMax);
				column.anchors.push(anchor);
			}

			this.columns.push(column);
		}
	}

	init(gl) {
		Client.loadFile(`data/texture/effect/${this.textureName}`, buffer => {
			WebGL.texture(gl, buffer, texture => {
				this.texture = texture;

				this.ready = true;
			});
		});
	}

	free(gl) {
		this.ready = false;
	}

	/**
	 * Update all phases in a column (advance toward random targets)
	 */
	updatePhases(column, stepScale = 1.0) {
		for (let i = 0; i < 16; i++) {
			const result = advancePhase(column.phases[i], column.phaseTargets[i], stepScale);
			column.phases[i] = result.angle;
			column.phaseTargets[i] = result.target;
		}
	}

	/**
	 * Update a single anchor within a column
	 * Reference behavior:
	 * - X,Z jitter: x += kx * sin(phaseA), z += kz * sin(phaseB) when y < 0
	 * - Y drift: y -= v each frame
	 * - Reset when y < resetY: x=z=0, y=rand[0,seedMax], reseed phases
	 */
	updateAnchor(column, anchorIndex, stepScale = 1.0) {
		const anchor = column.anchors[anchorIndex];
		const signs = ANCHOR_SIGNS[anchorIndex];
		const phaseOffsets = ANCHOR_PHASE_OFFSETS[anchorIndex];

		// Apply jitter only when below ground (y < 0)
		if (anchor.y < 0) {
			const phaseA = column.phases[phaseOffsets.pa] * DEG_TO_RAD;
			const phaseB = column.phases[phaseOffsets.pb] * DEG_TO_RAD;
			anchor.x += signs.kx * this.driftK * Math.sin(phaseA) * stepScale;
			anchor.z += signs.kz * this.driftK * Math.sin(phaseB) * stepScale;
		}

		// Drift downward
		anchor.y -= this.fallSpeed * debugConfig.fallSpeedMult * stepScale;

		// Reset when below threshold
		const resetLimit = this.resetY * debugConfig.respawnDepthMult;
		if (anchor.y < resetLimit) {
			anchor.x = 0;
			anchor.z = 0;
			anchor.y = randRange(0, this.seedMax);

			// Reseed the phase pair for this anchor
			column.phases[phaseOffsets.pa] = randRange(0, 360);
			column.phaseTargets[phaseOffsets.pa] = randRange(0, 360);
			column.phases[phaseOffsets.pb] = randRange(0, 360);
			column.phaseTargets[phaseOffsets.pb] = randRange(0, 360);
		}
	}

	/**
	 * Update all anchors and write instance data into _instanceData.
	 * Returns the number of active instances written.
	 *
	 * Instance stride: [anchorX, anchorY, anchorZ, zIndex]
	 * zIndex < 0 signals the vertex shader to discard the instance.
	 */
	_updateInstances(stepScale) {
		let idx = 0;
		for (let ec = 0; ec < this.columns.length; ec++) {
			const column = this.columns[ec];
			if (!column.life) {
				// Fill dead column's slots with sentinel so the shader skips them
				for (let ai = 0; ai < ANCHORS_PER_COL; ai++) {
					_instanceData[idx++] = 0;
					_instanceData[idx++] = 0;
					_instanceData[idx++] = 0;
					_instanceData[idx++] = -1; // zIndex < 0 → skip
				}
				continue;
			}

			this.updatePhases(column, stepScale);

			for (let ai = 0; ai < ANCHORS_PER_COL; ai++) {
				this.updateAnchor(column, ai, stepScale);
				const anchor = column.anchors[ai];

				// zIndex base offset (matches original line 421)
				const zIndexBase = 0.01 + ec * 0.002 + ai * 0.0001;

				// Dead condition: y > 0 (above spawn ceiling, not yet visible)
				// Alpha ≤ 0 is handled in the shader — write real zIndex and let
				// the shader discard via the alpha path.
				const isDead = anchor.y > 0;

				_instanceData[idx++] = anchor.x;
				_instanceData[idx++] = anchor.y;
				_instanceData[idx++] = anchor.z;
				_instanceData[idx++] = isDead ? -1 : zIndexBase;
			}
		}
		return idx / INSTANCE_STRIDE; // total instances written
	}

	render(gl, tick) {
		if (!this.ready || !this.texture) {
			return;
		}

		const uniform = _program.uniform;

		// Get ground position (world coordinates)
		const groundZ = Altitude.getCellHeight(this.position[0], this.position[1]);
		const basePos = [this.position[0] + 0.5, -groundZ - BASE_LIFT, this.position[1] + 0.5];

		// Camera orientation for billboarding
		const viewPitch = Camera.angle[0];
		const viewYaw = Camera.angle[1];
		const beta = ((360 - viewPitch + 90) % 360) * DEG_TO_RAD;
		const alpha = ((360 - viewYaw) % 360) * DEG_TO_RAD;

		const sinBeta = Math.sin(beta);
		const cosBeta = Math.cos(beta);
		const sinAlpha = Math.sin(alpha);
		const cosAlpha = Math.cos(alpha);

		gl.bindTexture(gl.TEXTURE_2D, this.texture);

		// Debug: show spawn volume
		if (debugConfig.showRedBg) {
			this.renderBackground(gl, basePos);
		}

		// Current billboard radius (in world units)
		const radius = this.baseRadius * GAME_TO_WORLD * debugConfig.scaleMult;

		const RAG_TICK_MS = 25;
		const dt = Math.min(tick - (this._lastTick || tick), 250);
		this._lastTick = tick;
		const stepScale = dt / RAG_TICK_MS;

		// Update all anchor simulation + fill _instanceData
		const instanceCount = this._updateInstances(stepScale);

		// Upload instance data once for this effect
		gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, _instanceData, 0, instanceCount * INSTANCE_STRIDE);

		// Upload uniforms once per effect per frame
		gl.uniform3f(uniform.uBasePos, basePos[0], basePos[1], basePos[2]);
		gl.uniform4f(uniform.uBillboard, sinBeta, cosBeta, sinAlpha, cosAlpha);
		gl.uniform1f(uniform.uRadius, radius);
		gl.uniform1f(uniform.uGameToWorld, GAME_TO_WORLD);
		gl.uniform2f(uniform.uAlphaParams, debugConfig.alphaOffset, debugConfig.alphaGain);
		gl.uniform4f(uniform.uColor, this.color.r, this.color.g, this.color.b, 1.0);

		const self = this;
		SpriteRenderer.runWithDepth(true, false, false, function () {
			for (let pass = 0; pass < self.passCount; pass++) {
				gl.uniform1f(uniform.uPassOffset, pass * 0.00005);
				gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
			}
		});
	}

	/**
	 * Debug background: draws the 6 faces of the spawn volume as semi-transparent red quads.
	 * Uses its own isolated _bgBuffer (legacy fillQuad path) so instancing state is not disturbed.
	 */
	renderBackground(gl, basePos) {
		const uniform = _program.uniform;
		const radius = this.baseRadius * GAME_TO_WORLD * debugConfig.bgRadiusFactor;
		const height = this.seedMax * GAME_TO_WORLD;

		const x0 = basePos[0] - radius;
		const x1 = basePos[0] + radius;
		const z0 = basePos[2] - radius;
		const z1 = basePos[2] + radius;
		const y0 = basePos[1];
		const y1 = basePos[1] + height;

		const self = this;

		function fillAndDraw(v0, v1, v2, v3) {
			// Triangle 1: v0-v1-v2
			_bgQuadData[0] = v0[0];
			_bgQuadData[1] = v0[1];
			_bgQuadData[2] = v0[2];
			_bgQuadData[3] = 0.0;
			_bgQuadData[4] = 0.0;
			_bgQuadData[5] = v1[0];
			_bgQuadData[6] = v1[1];
			_bgQuadData[7] = v1[2];
			_bgQuadData[8] = 1.0;
			_bgQuadData[9] = 0.0;
			_bgQuadData[10] = v2[0];
			_bgQuadData[11] = v2[1];
			_bgQuadData[12] = v2[2];
			_bgQuadData[13] = 1.0;
			_bgQuadData[14] = 1.0;
			// Triangle 2: v2-v3-v0
			_bgQuadData[15] = v2[0];
			_bgQuadData[16] = v2[1];
			_bgQuadData[17] = v2[2];
			_bgQuadData[18] = 1.0;
			_bgQuadData[19] = 1.0;
			_bgQuadData[20] = v3[0];
			_bgQuadData[21] = v3[1];
			_bgQuadData[22] = v3[2];
			_bgQuadData[23] = 0.0;
			_bgQuadData[24] = 1.0;
			_bgQuadData[25] = v0[0];
			_bgQuadData[26] = v0[1];
			_bgQuadData[27] = v0[2];
			_bgQuadData[28] = 0.0;
			_bgQuadData[29] = 0.0;

			gl.bindBuffer(gl.ARRAY_BUFFER, _bgBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, _bgQuadData);

			// Point attribute pointers at _bgBuffer (override instanced setup temporarily)
			const attribute = _program.attribute;
			// aCorner and aUV are not used for bg — we pack world positions directly in a
			// dedicated layout: aPosition(vec3) + aTextureCoord(vec2) reinterpreted via
			// the old attribute names. Since _program now uses aCorner/aUV we need a
			// compatibility shim: treat aCorner.xy as worldPos.xy and skip z via a 5-float
			// stride. Instead, to keep it simple and avoid shader rework, we fall back to
			// the old vertex layout (xyzuv) directly via the bg-specific buffer and drive
			// the draw with divisor=0 on all attribs.
			gl.vertexAttribDivisor(attribute.aAnchorPos, 0);
			gl.vertexAttribDivisor(attribute.aZIndex, 0);

			// Re-bind _bgBuffer and set aCorner to pull x,y from stride-5 xyzuv layout.
			// Use the world-space aCorner channel as a 2-component vec2 from (x,y) only.
			// This is a debug-only path so a one-draw-per-quad loop is acceptable.
			// We issue a standard non-instanced draw via a scratch 1-instance sentinel.
			gl.uniform1i(uniform.uSolidBg, 1);
			gl.uniform4f(uniform.uColor, 1.0, 0.0, 0.0, debugConfig.bgAlpha);
			gl.uniform1f(uniform.uPassOffset, 0.0);
			gl.uniform1f(uniform.uZIndex_bg || 0, 0.0005);

			SpriteRenderer.runWithDepth(true, true, false, function () {
				gl.drawArrays(gl.TRIANGLES, 0, 6);
			});

			// Restore divisors for instanced path
			gl.vertexAttribDivisor(attribute.aAnchorPos, 1);
			gl.vertexAttribDivisor(attribute.aZIndex, 1);
			// Rebind static quad buffer
			gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
			_rebindStaticAttribs(gl, attribute);
		}

		// Bottom
		fillAndDraw([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
		// Top
		fillAndDraw([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
		// Sides
		fillAndDraw([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
		fillAndDraw([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
		fillAndDraw([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
		fillAndDraw([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);

		gl.uniform1i(uniform.uSolidBg, 0);
	}

	static init(gl) {
		_program = WebGL.createShaderProgram(gl, _vertexShader, _fragmentShader);

		// --- Static quad buffer: 6 vertices, aCorner(vec2) + aUV(vec2) = 4 floats each ---
		// Two triangles matching original fillQuad layout:
		//   tri1: BL(-1,-1), BR(1,-1), TR(1,1)
		//   tri2: TR(1,1),  TL(-1,1), BL(-1,-1)
		// UVs:
		//   tri1: (0,0),(1,0),(1,1)
		//   tri2: (1,1),(0,1),(0,0)
		// clang-format off
		const quadVerts = new Float32Array([
			// aCorner.x, aCorner.y, aUV.x, aUV.y
			-1,
			-1,
			0,
			0, // BL
			1,
			-1,
			1,
			0, // BR
			1,
			1,
			1,
			1, // TR
			1,
			1,
			1,
			1, // TR
			-1,
			1,
			0,
			1, // TL
			-1,
			-1,
			0,
			0 // BL
		]);
		// clang-format on

		_buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
		gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

		// --- Instance buffer: MAX_INSTANCES * INSTANCE_STRIDE floats, DYNAMIC_DRAW ---
		_instanceBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * INSTANCE_STRIDE * 4, gl.DYNAMIC_DRAW);

		// --- Background debug buffer: legacy xyzuv layout, 30 floats ---
		_bgBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _bgBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, 30 * 4, gl.DYNAMIC_DRAW);

		this.ready = true;
		this.renderBeforeEntities = true;
	}

	static free(gl) {
		if (_program) {
			gl.deleteProgram(_program);
			_program = null;
		}
		if (_buffer) {
			gl.deleteBuffer(_buffer);
			_buffer = null;
		}
		if (_instanceBuffer) {
			gl.deleteBuffer(_instanceBuffer);
			_instanceBuffer = null;
		}
		if (_bgBuffer) {
			gl.deleteBuffer(_bgBuffer);
			_bgBuffer = null;
		}
		this.ready = false;
	}

	static beforeRender(gl, modelView, projection, fog) {
		const uniform = _program.uniform;
		const attribute = _program.attribute;

		gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive blend

		gl.useProgram(_program);

		gl.uniformMatrix4fv(uniform.uModelViewMat, false, modelView);
		gl.uniformMatrix4fv(uniform.uProjectionMat, false, projection);

		gl.uniform1i(uniform.uFogUse, fog.use && fog.exist);
		gl.uniform1f(uniform.uFogNear, fog.near);
		gl.uniform1f(uniform.uFogFar, fog.far);
		gl.uniform3fv(uniform.uFogColor, fog.color);

		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(uniform.uDiffuse, 0);
		gl.uniform1i(uniform.uSolidBg, 0);

		// Bind static quad buffer + enable per-vertex attribs
		gl.bindBuffer(gl.ARRAY_BUFFER, _buffer);
		gl.enableVertexAttribArray(attribute.aCorner);
		gl.enableVertexAttribArray(attribute.aUV);
		_rebindStaticAttribs(gl, attribute);

		// Bind instance buffer + enable per-instance attribs
		gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
		gl.enableVertexAttribArray(attribute.aAnchorPos);
		gl.enableVertexAttribArray(attribute.aZIndex);
		// stride = 4 floats = 16 bytes
		gl.vertexAttribPointer(attribute.aAnchorPos, 3, gl.FLOAT, false, INSTANCE_STRIDE * 4, 0);
		gl.vertexAttribPointer(attribute.aZIndex, 1, gl.FLOAT, false, INSTANCE_STRIDE * 4, 3 * 4);
		gl.vertexAttribDivisor(attribute.aAnchorPos, 1);
		gl.vertexAttribDivisor(attribute.aZIndex, 1);
	}

	static afterRender(gl) {
		const attribute = _program.attribute;
		// Reset divisors before disabling (WebGL2 requirement)
		gl.vertexAttribDivisor(attribute.aAnchorPos, 0);
		gl.vertexAttribDivisor(attribute.aZIndex, 0);
		gl.disableVertexAttribArray(attribute.aCorner);
		gl.disableVertexAttribArray(attribute.aUV);
		gl.disableVertexAttribArray(attribute.aAnchorPos);
		gl.disableVertexAttribArray(attribute.aZIndex);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	}
}

/**
 * Bind static quad attribute pointers (aCorner, aUV) from _buffer.
 * Called from beforeRender and after renderBackground restores _buffer.
 * stride = 4 floats = 16 bytes.
 */
function _rebindStaticAttribs(gl, attribute) {
	// _buffer must already be bound as ARRAY_BUFFER
	gl.vertexAttribPointer(attribute.aCorner, 2, gl.FLOAT, false, INSTANCE_STRIDE * 4, 0);
	gl.vertexAttribPointer(attribute.aUV, 2, gl.FLOAT, false, INSTANCE_STRIDE * 4, 2 * 4);
}

function _ensureDebugUI() {
	if (typeof document === 'undefined') {
		return;
	}
	if (document.getElementById(DEBUG_UI_ID)) {
		return;
	}

	const container = document.createElement('div');
	container.id = DEBUG_UI_ID;
	container.style.position = 'fixed';
	container.style.bottom = '12px';
	container.style.right = '12px';
	container.style.zIndex = 9999;
	container.style.background = 'rgba(20,20,20,0.8)';
	container.style.color = '#fff';
	container.style.padding = '8px';
	container.style.borderRadius = '4px';
	container.style.font = '12px sans-serif';
	container.style.pointerEvents = 'auto';

	const title = document.createElement('div');
	title.textContent = 'L99 Bubble Debug';
	title.style.marginBottom = '6px';
	title.style.fontWeight = 'bold';
	container.appendChild(title);

	function addSlider(labelText, min, max, step, value, onChange) {
		const row = document.createElement('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '6px';
		row.style.marginBottom = '4px';

		const label = document.createElement('span');
		label.textContent = labelText;
		label.style.whiteSpace = 'nowrap';
		row.appendChild(label);

		const input = document.createElement('input');
		input.type = 'range';
		input.min = min;
		input.max = max;
		input.step = step;
		input.value = value;
		input.style.flex = '1';
		input.addEventListener('input', function () {
			onChange(parseFloat(input.value));
		});
		row.appendChild(input);

		const valLabel = document.createElement('span');
		valLabel.textContent = value;
		input.addEventListener('input', function () {
			valLabel.textContent = input.value;
		});
		row.appendChild(valLabel);

		container.appendChild(row);
	}

	function addCheckbox(labelText, checked, onChange) {
		const row = document.createElement('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '6px';
		row.style.marginBottom = '4px';

		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', function () {
			onChange(!!input.checked);
		});
		row.appendChild(input);

		const label = document.createElement('span');
		label.textContent = labelText;
		row.appendChild(label);

		container.appendChild(row);
	}

	addSlider('Billboard size', 0.3, 3.0, 0.05, debugConfig.scaleMult, function (v) {
		debugConfig.scaleMult = v;
	});

	addSlider('Spawn height (seedMax)', 10, 150, 1, debugConfig.seedMax, function (v) {
		debugConfig.seedMax = v;
	});

	addSlider('Fall speed mult', 0.1, 5.0, 0.05, debugConfig.fallSpeedMult, function (v) {
		debugConfig.fallSpeedMult = v;
	});

	addSlider('Respawn depth mult', 0.1, 5.0, 0.05, debugConfig.respawnDepthMult, function (v) {
		debugConfig.respawnDepthMult = v;
	});

	addSlider('Alpha offset', -50, 50, 1, debugConfig.alphaOffset, function (v) {
		debugConfig.alphaOffset = v;
	});

	addSlider('Alpha gain', 1, 80, 1, debugConfig.alphaGain, function (v) {
		debugConfig.alphaGain = v;
	});

	addSlider('Floor limit', 10, 60, 1, debugConfig.floorLimit, function (v) {
		debugConfig.floorLimit = v;
	});

	addCheckbox('Show spawn volume', debugConfig.showRedBg, function (v) {
		debugConfig.showRedBg = v;
	});

	document.body.appendChild(container);
}

// Initialize temporary debug UI once
// Temporarily disabled; will be re-enabled via a future interface
// _ensureDebugUI();
export default Level99Bubble;

