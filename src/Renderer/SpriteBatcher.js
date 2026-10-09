/**
 * Renderer/SpriteBatcher.js
 *
 * Instanced sprite rendering batcher (WebGL2).
 *
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import WebGL from 'Utils/WebGL.js';
import Camera from './Camera.js';
import TextureArrayManager from './TextureArrayManager.js';
import _vertexShader from './SpriteBatcher.vs?raw';
import _fragmentShader from './SpriteBatcher.fs?raw';

// ---- Layout ---------------------------------------------------------------

export const FLOATS_PER_INSTANCE = 21;
export const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

const OFF_POSITION = 0; // vec3
const OFF_COLOR = 3; // vec4
const OFF_SIZE = 7; // vec2
const OFF_OFFSET = 9; // vec2
const OFF_ZINDEX = 11; // float
const OFF_DEPTH = 12; // float
const OFF_SHADOW = 13; // float
const OFF_ANGLE = 14; // float
const OFF_FLAGS = 15; // float -> int
const OFF_TEXTSIZE = 16; // vec2
const OFF_TEXTURE_LAYER = 18; // float
const OFF_UV_SCALE = 19; // vec2

export const FLAG_USE_PAL = 1 << 1;
export const FLAG_DISABLE_DEPTH_CORRECTION = 1 << 2;
export const FLAG_IGNORE_ZINDEX_CAP = 1 << 3;
export const FLAG_USE_ARRAY = 1 << 4;

export const BLEND_DEFAULT = 0;
export const BLEND_ONE = 1;

const DEFAULT_MAX_INSTANCES = 2048;

const ARRAY_LAYER_SIZE = 256;
const ARRAY_INITIAL_CAP = 64;
const ARRAY_MAX_CAP = 128;

// ---- Class ----------------------------------------------------------------

class SpriteBatcher {
	constructor(maxInstances = DEFAULT_MAX_INSTANCES) {
		this._maxInstances = maxInstances;
		this._data = new Float32Array(maxInstances * FLOATS_PER_INSTANCE);
		this._count = 0;

		this._gl = null;
		this._program = null;
		this._quadBuffer = null;
		this._instanceBuffer = null;
		this._vao = null;
		this._attributes = null;
		this._uniforms = null;

		this._arrayManager = null;

		// Pending batch identity
		this._texture = null;
		this._palette = null;
		this._blendMode = BLEND_DEFAULT;
		this._isArrayBatch = false;

		// Cached GL state
		this._glBlendMode = 0;
		this._glDepthTest = null;
		this._glDepthMask = null;
	}

	get count() {
		return this._count;
	}
	get hasPending() {
		return this._count > 0;
	}

	init(gl) {
		if (this._gl === gl && this._program && this._vao) return;
		this._gl = gl;

		if (!this._program) {
			this._program = WebGL.createShaderProgram(gl, _vertexShader, _fragmentShader);
			this._attributes = this._program.attribute;
			this._uniforms = this._program.uniform;
		}

		if (!this._arrayManager) {
			this._arrayManager = new TextureArrayManager(gl, {
				layerSize: ARRAY_LAYER_SIZE,
				initialCapacity: ARRAY_INITIAL_CAP,
				maxCapacity: ARRAY_MAX_CAP
			});
		}

		if (!this._quadBuffer) {
			this._quadBuffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([
					-0.5, +0.5, 0.0, 0.0, +0.5, +0.5, 1.0, 0.0, -0.5, -0.5, 0.0, 1.0, +0.5, -0.5, 1.0, 1.0
				]),
				gl.STATIC_DRAW
			);
		}

		if (!this._instanceBuffer) {
			this._instanceBuffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this._data.byteLength, gl.DYNAMIC_DRAW);
		}

		if (!this._vao) {
			this._vao = gl.createVertexArray();
			gl.bindVertexArray(this._vao);

			const attr = this._attributes;

			gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
			gl.enableVertexAttribArray(attr.aPosition);
			gl.vertexAttribPointer(attr.aPosition, 2, gl.FLOAT, false, 4 * 4, 0);
			gl.vertexAttribDivisor(attr.aPosition, 0);

			gl.enableVertexAttribArray(attr.aTextureCoord);
			gl.vertexAttribPointer(attr.aTextureCoord, 2, gl.FLOAT, false, 4 * 4, 2 * 4);
			gl.vertexAttribDivisor(attr.aTextureCoord, 0);

			gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);

			const setInst = (loc, size, offsetFloats) => {
				gl.enableVertexAttribArray(loc);
				gl.vertexAttribPointer(loc, size, gl.FLOAT, false, BYTES_PER_INSTANCE, offsetFloats * 4);
				gl.vertexAttribDivisor(loc, 1);
			};

			setInst(attr.iPosition, 3, OFF_POSITION);
			setInst(attr.iColor, 4, OFF_COLOR);
			setInst(attr.iSize, 2, OFF_SIZE);
			setInst(attr.iOffset, 2, OFF_OFFSET);
			setInst(attr.iZindex, 1, OFF_ZINDEX);
			setInst(attr.iDepth, 1, OFF_DEPTH);
			setInst(attr.iShadow, 1, OFF_SHADOW);
			setInst(attr.iAngle, 1, OFF_ANGLE);
			setInst(attr.iFlags, 1, OFF_FLAGS);
			setInst(attr.iTextSize, 2, OFF_TEXTSIZE);
			setInst(attr.iTextureLayer, 1, OFF_TEXTURE_LAYER);
			setInst(attr.iUvScale, 2, OFF_UV_SCALE);

			gl.bindVertexArray(null);
		}
	}

	bindGlobals(gl, modelView, projection, viewModel, fog) {
		const uniform = this._uniforms;
		gl.useProgram(this._program);

		gl.uniformMatrix4fv(uniform.uProjectionMat, false, projection);
		gl.uniformMatrix4fv(uniform.uModelViewMat, false, modelView);
		gl.uniformMatrix4fv(uniform.uViewModelMat, false, viewModel);

		gl.uniform1f(uniform.uCameraZoom, Camera.zoom);
		gl.uniform1f(uniform.uCameraLatitude, Camera.getLatitude());

		gl.uniform1i(uniform.uFogUse, fog.use && fog.exist);
		gl.uniform1f(uniform.uFogNear, fog.near);
		gl.uniform1f(uniform.uFogFar, fog.far);
		gl.uniform3fv(uniform.uFogColor, fog.color);

		gl.uniform1i(uniform.uDiffuse, 0);
		gl.uniform1i(uniform.uPalette, 1);
		gl.uniform1i(uniform.uSpriteArray, 2);

		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._arrayManager.texture);
		gl.activeTexture(gl.TEXTURE0);
	}

	applyDepthState(gl, depthTest, depthMask) {
		if (this._glDepthTest !== depthTest) {
			this._glDepthTest = depthTest;
			if (depthTest) gl.enable(gl.DEPTH_TEST);
			else gl.disable(gl.DEPTH_TEST);
		}
		if (this._glDepthMask !== depthMask) {
			this._glDepthMask = depthMask;
			gl.depthMask(depthMask);
		}
	}

	addSprite(gl, state, isBlendModeOne) {
		// --- Blend mode ---------------------------------------------------
		const blendMode =
			isBlendModeOne === true ? BLEND_ONE : isBlendModeOne === false ? BLEND_DEFAULT : this._blendMode;

		// --- Array path (RGBA) -------------------------------------
		const frame = state.sprite;
		let arrayEntry = null;
		if (frame && frame.type === 1 && state.image.texture) {
			if (frame.data instanceof Uint8Array && frame.width === frame.originalWidth) {
				arrayEntry = this._arrayManager.getLayerFromPixels(
					state.image.texture,
					frame.data,
					frame.width,
					frame.height
				);
			} else {
				arrayEntry = this._arrayManager.getLayer(state.image.texture, frame.width, frame.height);
			}
		}
		if (frame && frame.type === 1 && state.image.texture) {
			arrayEntry = this._arrayManager.getLayer(state.image.texture, frame.width, frame.height);
		}
		const isArray = !!arrayEntry;

		const nextTexture = isArray ? null : state.image.texture;
		const nextPalette = isArray ? null : state.image.palette;

		const blendChanged = blendMode !== this._blendMode;
		const arrayChanged = this._count > 0 && isArray !== this._isArrayBatch;
		const textureChanged =
			this._count > 0 && !isArray && (nextTexture !== this._texture || nextPalette !== this._palette);

		if (this._count > 0 && (blendChanged || arrayChanged || textureChanged)) {
			this.flush(gl);
		}

		if (blendChanged) this._blendMode = blendMode;
		this._texture = nextTexture;
		this._palette = nextPalette;
		this._isArrayBatch = isArray;

		if (this._count >= this._maxInstances) this.flush(gl);

		// --- Write instance ----------------------------------------------
		const off = this._count * FLOATS_PER_INSTANCE;
		const d = this._data;

		d[off + OFF_POSITION + 0] = state.position[0];
		d[off + OFF_POSITION + 1] = state.position[1];
		d[off + OFF_POSITION + 2] = state.position[2];

		d[off + OFF_COLOR + 0] = state.color[0];
		d[off + OFF_COLOR + 1] = state.color[1];
		d[off + OFF_COLOR + 2] = state.color[2];
		d[off + OFF_COLOR + 3] = state.color[3];

		const INV_175 = 1 / 175.0;
		const xs = state.xSize;
		const ys = state.ySize;

		d[off + OFF_SIZE + 0] = state.size[0] * INV_175 * xs;
		d[off + OFF_SIZE + 1] = state.size[1] * INV_175 * ys;
		d[off + OFF_OFFSET + 0] = state.offset[0] * INV_175 * xs;
		d[off + OFF_OFFSET + 1] = state.offset[1] * INV_175 * ys - 0.5;

		d[off + OFF_ZINDEX] = state.zIndex++;
		d[off + OFF_DEPTH] = state.depth;
		d[off + OFF_SHADOW] = state.shadow;
		d[off + OFF_ANGLE] = state.angle;

		let flags = 0;
		if (state.image.palette) flags |= FLAG_USE_PAL;
		if (state.disableDepthCorrection) flags |= FLAG_DISABLE_DEPTH_CORRECTION;
		if (state.ignoreDepthMinCap) flags |= FLAG_IGNORE_ZINDEX_CAP;
		if (isArray) flags |= FLAG_USE_ARRAY;
		d[off + OFF_FLAGS] = flags;

		d[off + OFF_TEXTSIZE + 0] = state.image.size[0];
		d[off + OFF_TEXTSIZE + 1] = state.image.size[1];

		if (isArray) {
			d[off + OFF_TEXTURE_LAYER] = arrayEntry.layer;
			d[off + OFF_UV_SCALE + 0] = arrayEntry.uvScaleX;
			d[off + OFF_UV_SCALE + 1] = arrayEntry.uvScaleY;
		} else {
			d[off + OFF_TEXTURE_LAYER] = 0.0;
			d[off + OFF_UV_SCALE + 0] = 1.0;
			d[off + OFF_UV_SCALE + 1] = 1.0;
		}

		this._count++;
	}

	flush(gl /*, state */) {
		if (this._count === 0) return;
		gl.useProgram(this._program);
		// --- Blend --------------------------------------------------------
		if (this._glBlendMode !== this._blendMode) {
			if (this._blendMode === BLEND_ONE) {
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
			} else {
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			}
			this._glBlendMode = this._blendMode;
		}

		// --- Upload -------------------------------------------------------
		gl.bindBuffer(gl.ARRAY_BUFFER, this._instanceBuffer);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._data, 0, this._count * FLOATS_PER_INSTANCE);

		// --- Texturas -----------------------------------------------------
		if (this._isArrayBatch) {
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._arrayManager.texture);
			gl.activeTexture(gl.TEXTURE0);
		} else {
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this._texture);
			if (this._palette) {
				gl.activeTexture(gl.TEXTURE1);
				gl.bindTexture(gl.TEXTURE_2D, this._palette);
				gl.activeTexture(gl.TEXTURE0);
			}
		}

		// --- Draw ---------------------------------------------------------
		gl.bindVertexArray(this._vao);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._count);
		gl.bindVertexArray(null);

		// --- Reset --------------------------------------------------------
		this._count = 0;
		this._texture = null;
		this._palette = null;
		this._isArrayBatch = false;
	}

	reset() {
		this._count = 0;
		this._texture = null;
		this._palette = null;
		this._isArrayBatch = false;
	}

	dispose(gl) {
		if (this._arrayManager) this._arrayManager.dispose();
		if (this._vao) gl.deleteVertexArray(this._vao);
		if (this._quadBuffer) gl.deleteBuffer(this._quadBuffer);
		if (this._instanceBuffer) gl.deleteBuffer(this._instanceBuffer);
		if (this._program && this._program.program) gl.deleteProgram(this._program.program);

		this._arrayManager = null;
		this._vao = null;
		this._quadBuffer = null;
		this._instanceBuffer = null;
		this._program = null;
		this._gl = null;
		this._count = 0;
	}
}

export default SpriteBatcher;
